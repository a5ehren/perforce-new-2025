import * as vscode from "vscode";
import { PerforceService } from "./PerforceService";
import {
  P4Options,
  P4DescribeResult,
  P4Annotation,
  P4JobSummary,
  P4ChangeSummary,
  P4CommandContext,
  P4Info,
} from "./p4/p4Types";
import { getP4OptionsFromConfig } from "./p4/p4Utils";
import { RepositoryStateManager, P4File } from "./RepositoryStateManager";
import {
  p4edit,
  p4revert,
  p4add,
  p4delete,
  p4sync,
  p4move,
  p4diff2,
  p4resolve,
  p4where,
} from "./p4/fileCommands";
import {
  p4newChangeSpec,
  p4editChangeSpec,
  p4saveChangeSpec,
  p4submit,
  p4describe,
  p4changes,
} from "./p4/changelistCommands";
import { p4shelve, p4unshelve } from "./p4/shelveCommands";
import { p4fixJob, p4job, p4jobs } from "./p4/jobCommands";
import { p4annotate, p4filelog } from "./p4/historyCommands";

export class PerforceSCMProvider implements vscode.Disposable {
  private _scm: vscode.SourceControl;
  private _repositoryStateManager: RepositoryStateManager;
  private _perforceService: PerforceService;
  private _outputChannel: vscode.OutputChannel;
  private _disposables: vscode.Disposable[] = [];
  public readonly rootUri: vscode.Uri;

  constructor(contextUri: vscode.Uri, outputChannel: vscode.OutputChannel) {
    this._outputChannel = outputChannel;
    this.rootUri = contextUri;

    const scmId = `perforce-${contextUri.toString()}`;
    const scmTitle = `Perforce (${vscode.workspace.asRelativePath(contextUri)})`;
    this._scm = vscode.scm.createSourceControl(scmId, scmTitle, contextUri);

    const p4Options = getP4OptionsFromConfig(contextUri);
    this._perforceService = new PerforceService(this._outputChannel);
    this._repositoryStateManager = new RepositoryStateManager(
      this._perforceService,
      this._outputChannel,
      p4Options,
    );

    this._scm.inputBox.placeholder = "Enter changelist description";

    this._repositoryStateManager.onDidChange(
      this.onStateChange,
      this,
      this._disposables,
    );

    this._disposables.push(
      vscode.commands.registerCommand("perforce.Refresh", async () => {
        this._outputChannel.appendLine(`Refresh triggered for ${scmTitle}`);
        await this.refresh();
      }),
      this._scm,
    );

    this._outputChannel.appendLine(
      `Perforce SCM Provider initialized for ${scmTitle}`,
    );

    this.refresh();
  }

  public getScmInputBoxMessage(): string {
    return this._scm.inputBox.value;
  }

  public clearScmInputBoxMessage(): void {
    this._scm.inputBox.value = "";
  }

  private async refresh(): Promise<void> {
    await this._repositoryStateManager.updateState(this.rootUri);
  }

  private onStateChange(): void {
    this._outputChannel.appendLine(
      `Updating SCM view for ${this._scm.label}...`,
    );

    const changelists = this._repositoryStateManager.getAllChangelists();
    const allFiles = this._repositoryStateManager.getAllFiles();

    this._scm.inputBox.value = "";
    const groups: vscode.SourceControlResourceGroup[] = [];

    changelists.forEach((change) => {
      const groupLabel = `${change.id === "default" ? "Default" : change.id}: ${change.description.substring(0, 50)}${change.description.length > 50 ? "..." : ""}`;
      const group = this._scm.createResourceGroup(change.id, groupLabel);

      const filesInChange = allFiles.filter((f) => f.changelist === change.id);

      group.resourceStates = filesInChange.map((file) =>
        this.createResourceState(file),
      );

      groups.push(group);
    });

    const config = vscode.workspace.getConfiguration(
      "perforce",
      this._scm.rootUri,
    );
    const countBadgeMode = config.get<string>("countBadge", "all-but-shelved");

    let count = 0;
    if (countBadgeMode === "all") {
      count = allFiles.length;
    } else if (countBadgeMode === "all-but-shelved") {
      count = allFiles.filter((f) => !f.isShelved).length;
    }
    this._scm.count = count > 0 ? count : undefined;

    this._outputChannel.appendLine("SCM view updated.");
  }

  private createResourceState(file: P4File): vscode.SourceControlResourceState {
    const resourceUri = file.uri;
    let tooltip = `${file.depotPath}\nStatus: ${file.status}`;
    if (file.changelist) {
      tooltip += `\nChangelist: ${file.changelist}`;
    }
    if (file.type) {
      tooltip += `\nType: ${file.type}`;
    }

    const strikeThrough =
      file.action === "delete" ||
      file.action === "move/delete" ||
      file.action === "purge" ||
      file.action === "archive";

    let GutterIconPath: vscode.Uri | undefined;
    let DecorationColorId: string | undefined;
    let faded = false;

    switch (file.action) {
      case "add":
      case "move/add":
      case "branch":
        DecorationColorId = "perforceDecoration.addForeground";
        break;
      case "delete":
      case "move/delete":
      case "purge":
      case "archive":
        DecorationColorId = "perforceDecoration.deleteForeground";
        break;
      case "edit":
      case "integrate":
        DecorationColorId = "perforceDecoration.editForeground";
        break;
      case "lock":
        DecorationColorId = "perforceDecoration.lockForeground";
        break;
      case "import":
        DecorationColorId = "perforceDecoration.importForeground";
        break;
    }

    if (
      file.diffStatus === "unresolved" ||
      file.diffStatus === "reresolvable"
    ) {
      DecorationColorId = "perforceDecoration.unresolvedForeground";
      tooltip += `\n${file.diffStatus.toUpperCase()}`;
    }

    if (file.isShelved) {
      faded = true;
      tooltip += "\n(Shelved)";
    }

    return {
      resourceUri,
      command: {
        title: "Open Changes",
        command: "perforce.openResource",
        arguments: [resourceUri, file.changelist, file.status, file.isShelved],
        tooltip: "Diff against depot or shelved version",
      },
      decorations: {
        tooltip,
        strikeThrough,
        light: {},
        dark: {},
        faded: faded,
      },
      contextValue: `p4file:${file.action ?? "unknown"}${file.isShelved ? ":shelved" : ""}${file.diffStatus === "unresolved" ? ":unres" : ""}`,
    };
  }

  public async editFile(resourceUri: vscode.Uri): Promise<void> {
    this._outputChannel.appendLine(
      `SCM Provider: Request to edit ${resourceUri.fsPath}`,
    );
    const p4Options = getP4OptionsFromConfig(resourceUri);
    const context: P4CommandContext = {
      execute: this._perforceService.execute.bind(this._perforceService),
      outputChannel: this._outputChannel,
    };
    try {
      await p4edit(context, resourceUri.fsPath, p4Options);
      await this.refresh();
    } catch (error: any) {
      this._outputChannel.appendLine(
        `SCM Provider: Error during p4edit for ${resourceUri.fsPath}: ${error.message}`,
      );
      throw error;
    }
  }

  public async revertFile(resourceUri: vscode.Uri): Promise<void> {
    this._outputChannel.appendLine(
      `SCM Provider: Request to revert ${resourceUri.fsPath}`,
    );
    const p4Options = getP4OptionsFromConfig(resourceUri);
    const context: P4CommandContext = {
      execute: this._perforceService.execute.bind(this._perforceService),
      outputChannel: this._outputChannel,
    };
    try {
      await p4revert(context, resourceUri.fsPath, p4Options);
      await this.refresh();
    } catch (error: any) {
      this._outputChannel.appendLine(
        `SCM Provider: Error during p4revert for ${resourceUri.fsPath}: ${error.message}`,
      );
      throw error;
    }
  }

  public async addFile(resourceUri: vscode.Uri): Promise<void> {
    this._outputChannel.appendLine(
      `SCM Provider: Request to add ${resourceUri.fsPath}`,
    );
    const p4Options = getP4OptionsFromConfig(resourceUri);
    const context: P4CommandContext = {
      execute: this._perforceService.execute.bind(this._perforceService),
      outputChannel: this._outputChannel,
    };
    try {
      await p4add(context, resourceUri.fsPath, p4Options);
      await this.refresh();
    } catch (error: any) {
      this._outputChannel.appendLine(
        `SCM Provider: Error during p4add for ${resourceUri.fsPath}: ${error.message}`,
      );
      throw error;
    }
  }

  public async deleteFile(resourceUri: vscode.Uri): Promise<void> {
    this._outputChannel.appendLine(
      `SCM Provider: Request to delete ${resourceUri.fsPath}`,
    );
    const p4Options = getP4OptionsFromConfig(resourceUri);
    const context: P4CommandContext = {
      execute: this._perforceService.execute.bind(this._perforceService),
      outputChannel: this._outputChannel,
    };
    try {
      await p4delete(context, resourceUri.fsPath, p4Options);
      await this.refresh();
    } catch (error: any) {
      this._outputChannel.appendLine(
        `SCM Provider: Error during p4delete for ${resourceUri.fsPath}: ${error.message}`,
      );
      throw error;
    }
  }

  public async syncFiles(resourceUris: vscode.Uri[]): Promise<void> {
    this._outputChannel.appendLine(
      `SCM Provider: Request to sync ${resourceUris.length > 0 ? resourceUris.length + " specific files" : "all files"} in ${this.rootUri.fsPath}`,
    );
    const p4Options = getP4OptionsFromConfig(this.rootUri);
    const context: P4CommandContext = {
      execute: this._perforceService.execute.bind(this._perforceService),
      outputChannel: this._outputChannel,
    };
    try {
      const filePaths = resourceUris.map((uri) => uri.fsPath);
      await p4sync(context, filePaths, p4Options);
      await this.refresh();
    } catch (error: any) {
      this._outputChannel.appendLine(
        `SCM Provider: Error during p4sync for ${this.rootUri.fsPath}: ${error.message}`,
      );
      throw error;
    }
  }

  public async moveFile(
    sourceUri: vscode.Uri,
    targetUri: vscode.Uri,
  ): Promise<void> {
    this._outputChannel.appendLine(
      `SCM Provider: Request to move ${sourceUri.fsPath} to ${targetUri.fsPath}`,
    );
    const p4Options = getP4OptionsFromConfig(this.rootUri);
    const context: P4CommandContext = {
      execute: this._perforceService.execute.bind(this._perforceService),
      outputChannel: this._outputChannel,
    };
    try {
      await p4move(context, sourceUri.fsPath, targetUri.fsPath, p4Options);
      await this.refresh();
    } catch (error: any) {
      this._outputChannel.appendLine(
        `SCM Provider: Error during p4move from ${sourceUri.fsPath}: ${error.message}`,
      );
      throw error;
    }
  }

  public async openResource(
    resourceUri: vscode.Uri,
    commandArgs?: any[],
  ): Promise<void> {
    this._outputChannel.appendLine(
      `SCM Provider: Request to open resource ${resourceUri.fsPath}`,
    );
    this._outputChannel.appendLine(
      `  Command args: ${JSON.stringify(commandArgs)}`,
    );

    const p4Options = getP4OptionsFromConfig(this.rootUri);
    const context: P4CommandContext = {
      execute: this._perforceService.execute.bind(this._perforceService),
      outputChannel: this._outputChannel,
    };

    const [, _changelist, status, isShelved] = commandArgs ?? [];
    const localPath = resourceUri.fsPath;
    let title = `${vscode.workspace.asRelativePath(resourceUri)}`;

    try {
      // Get cached file state if available
      const fileState = this._repositoryStateManager.getFileState(resourceUri);

      // Determine depot path - use cached state first, fallback to p4 where
      let depotPath: string | null | undefined = fileState?.depotPath;
      if (!depotPath) {
        this._outputChannel.appendLine(
          ` Depot path not cached for ${localPath}, running p4 where...`,
        );
        depotPath = await p4where(context, localPath, p4Options);
      }

      if (!depotPath) {
        this._outputChannel.appendLine(
          ` Could not determine depot path for ${localPath}. Opening local file only.`,
        );
        await vscode.commands.executeCommand("vscode.open", resourceUri);
        return;
      }

      let leftSpec: string | undefined;
      let rightSpec: string = localPath; // Local file is always on the right

      // Use status from command args if available, otherwise from cached state
      const effectiveStatus = status ?? fileState?.status;

      if (isShelved) {
        // Diff shelved vs local
        leftSpec = `${depotPath}@=${_changelist}`; // Diff against shelved version in specified changelist
        title += ` (Shelved CL ${_changelist} vs Local)`;
      } else if (
        effectiveStatus === "add" ||
        effectiveStatus === "branch" ||
        effectiveStatus === "import"
      ) {
        // No previous revision to diff against for add/branch/import
        this._outputChannel.appendLine(
          ` Opening local file for action '${effectiveStatus}'. No depot diff available.`,
        );
        await vscode.commands.executeCommand("vscode.open", resourceUri);
        return;
      } else if (
        effectiveStatus === "edit" ||
        effectiveStatus === "integrate"
      ) {
        // Diff #have vs local file
        leftSpec = `${depotPath}#have`;
        title += ` (Depot #have vs Local)`;
      } else if (
        effectiveStatus === "delete" ||
        effectiveStatus === "move/delete"
      ) {
        // Show the depot version that was deleted
        leftSpec = `${depotPath}#have`;
        title += ` (Showing deleted revision #have)`;
        // Can't diff against non-existent local file, just open the left side
        const leftUri = vscode.Uri.parse(`perforce:${leftSpec}`); // Requires FileSystemProvider
        // TODO: Implement FileSystemProvider for depot paths
        this._outputChannel.appendLine(
          ` TODO: Need FileSystemProvider to show depot content for ${leftSpec}`,
        );
        vscode.window.showInformationMessage(
          `Showing deleted file content requires depot FileSystemProvider (TODO). Opening local path (may not exist).`,
        );
        // Attempt to open local path anyway, it might still exist temporarily
        await vscode.commands.executeCommand("vscode.open", resourceUri);
        return;
      } else {
        // Default: diff head vs local (for unmodified files or unknown status)
        // Use #head as a sensible default if no other status matches
        leftSpec = `${depotPath}#head`;
        title += ` (Depot #head vs Local)`;
      }

      if (leftSpec) {
        // TODO: Implement FileSystemProvider to handle depot URIs like `perforce://depot/path#rev`
        // For now, we cannot create the left URI for vscode.diff
        this._outputChannel.appendLine(
          ` TODO: Need FileSystemProvider to create URI for depot content: ${leftSpec}`,
        );
        vscode.window.showInformationMessage(
          `Diffing requires depot FileSystemProvider (TODO). Opening local file ${localPath} instead.`,
        );
        await vscode.commands.executeCommand("vscode.open", resourceUri);
        // When FileSystemProvider exists:
        // const leftUri = vscode.Uri.parse(`perforce:${leftSpec}?root=${encodeURIComponent(this.rootUri.toString())}`); // Include rootUri for context
        // const rightUri = resourceUri;
        // await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title);
      } else {
        // Fallback: open local file if no diff applicable
        await vscode.commands.executeCommand("vscode.open", resourceUri);
      }
    } catch (error: any) {
      this._outputChannel.appendLine(
        `SCM Provider: Error opening resource ${resourceUri.fsPath}: ${error.message}`,
      );
      // Fallback to opening local file on error
      await vscode.commands.executeCommand("vscode.open", resourceUri);
      throw error; // Rethrow so handler can show message
    }
  }

  public async getNewChangeSpec(): Promise<string> {
    this._outputChannel.appendLine(`SCM Provider: Requesting new change spec.`);
    const p4Options = getP4OptionsFromConfig(this.rootUri);
    const context: P4CommandContext = {
      execute: this._perforceService.execute.bind(this._perforceService),
      outputChannel: this._outputChannel,
    };
    try {
      return await p4newChangeSpec(context, p4Options);
    } catch (error: any) {
      this._outputChannel.appendLine(
        `SCM Provider: Error getting new change spec: ${error.message}`,
      );
      throw error;
    }
  }

  public async getChangeSpec(changelistId: string): Promise<string> {
    this._outputChannel.appendLine(
      `SCM Provider: Requesting change spec for ${changelistId}.`,
    );
    const p4Options = getP4OptionsFromConfig(this.rootUri);
    const context: P4CommandContext = {
      execute: this._perforceService.execute.bind(this._perforceService),
      outputChannel: this._outputChannel,
    };
    try {
      return await p4editChangeSpec(context, changelistId, p4Options);
    } catch (error: any) {
      this._outputChannel.appendLine(
        `SCM Provider: Error getting change spec for ${changelistId}: ${error.message}`,
      );
      throw error;
    }
  }

  public async saveChangeSpec(spec: string): Promise<string> {
    this._outputChannel.appendLine(
      `SCM Provider: Requesting save change spec.`,
    );
    const p4Options = getP4OptionsFromConfig(this.rootUri);
    const context: P4CommandContext = {
      execute: this._perforceService.execute.bind(this._perforceService),
      outputChannel: this._outputChannel,
    };
    try {
      const changeId = await p4saveChangeSpec(context, spec, p4Options);
      await this.refresh();
      return changeId;
    } catch (error: any) {
      this._outputChannel.appendLine(
        `SCM Provider: Error saving change spec: ${error.message}`,
      );
      throw error;
    }
  }

  public async submitChange(
    changelistId?: string,
    description?: string,
  ): Promise<{
    submittedChange?: string;
    success?: boolean;
    message?: string;
  } | null> {
    const target = changelistId ?? "default";
    this._outputChannel.appendLine(
      `SCM Provider: Requesting submit for changelist ${target}.`,
    );
    const p4Options = getP4OptionsFromConfig(this.rootUri);
    const context: P4CommandContext = {
      execute: this._perforceService.execute.bind(this._perforceService),
      outputChannel: this._outputChannel,
    };
    try {
      if (!changelistId && description) {
        this._outputChannel.appendLine(
          ` Warning: Submitting default changelist with description is not fully implemented. Description ignored.`,
        );
      }

      const result = await p4submit(context, changelistId, p4Options);
      await this.refresh();
      return result;
    } catch (error: any) {
      this._outputChannel.appendLine(
        `SCM Provider: Error submitting change ${target}: ${error.message}`,
      );
      await this.refresh();
      throw error;
    }
  }

  public async describeChange(
    changelistId: string,
  ): Promise<P4DescribeResult | null> {
    this._outputChannel.appendLine(
      `SCM Provider: Requesting describe for changelist ${changelistId}.`,
    );
    const p4Options = getP4OptionsFromConfig(this.rootUri);
    const context: P4CommandContext = {
      execute: this._perforceService.execute.bind(this._perforceService),
      outputChannel: this._outputChannel,
    };
    try {
      return await p4describe(context, changelistId, p4Options);
    } catch (error: any) {
      this._outputChannel.appendLine(
        `SCM Provider: Error describing change ${changelistId}: ${error.message}`,
      );
      throw error;
    }
  }

  public async shelveChange(changelistId: string): Promise<void> {
    this._outputChannel.appendLine(
      `SCM Provider: Requesting shelve for changelist ${changelistId}.`,
    );
    const p4Options = getP4OptionsFromConfig(this.rootUri);
    const context: P4CommandContext = {
      execute: this._perforceService.execute.bind(this._perforceService),
      outputChannel: this._outputChannel,
    };
    try {
      await p4shelve(context, changelistId, p4Options);
      await this.refresh();
    } catch (error: any) {
      this._outputChannel.appendLine(
        `SCM Provider: Error shelving change ${changelistId}: ${error.message}`,
      );
      await this.refresh();
      throw error;
    }
  }

  public async unshelveChange(
    shelvedChangeId: string,
    targetChangeId?: string,
  ): Promise<void> {
    this._outputChannel.appendLine(
      `SCM Provider: Requesting unshelve from ${shelvedChangeId} into ${targetChangeId ?? "default"}.`,
    );
    const p4Options = getP4OptionsFromConfig(this.rootUri);
    const context: P4CommandContext = {
      execute: this._perforceService.execute.bind(this._perforceService),
      outputChannel: this._outputChannel,
    };
    try {
      await p4unshelve(context, shelvedChangeId, targetChangeId, p4Options);
      await this.refresh();
    } catch (error: any) {
      this._outputChannel.appendLine(
        `SCM Provider: Error unshelving change ${shelvedChangeId}: ${error.message}`,
      );
      await this.refresh();
      throw error;
    }
  }

  public async fixJob(changelistId: string, jobId: string): Promise<void> {
    this._outputChannel.appendLine(
      `SCM Provider: Requesting fix job ${jobId} for change ${changelistId}.`,
    );
    const p4Options = getP4OptionsFromConfig(this.rootUri);
    const context: P4CommandContext = {
      execute: this._perforceService.execute.bind(this._perforceService),
      outputChannel: this._outputChannel,
    };
    try {
      await p4fixJob(context, changelistId, jobId, p4Options, false);
      await this.refresh();
    } catch (error: any) {
      this._outputChannel.appendLine(
        `SCM Provider: Error fixing job ${jobId} for change ${changelistId}: ${error.message}`,
      );
      throw error;
    }
  }

  public async unfixJob(changelistId: string, jobId: string): Promise<void> {
    this._outputChannel.appendLine(
      `SCM Provider: Requesting unfix job ${jobId} for change ${changelistId}.`,
    );
    const p4Options = getP4OptionsFromConfig(this.rootUri);
    const context: P4CommandContext = {
      execute: this._perforceService.execute.bind(this._perforceService),
      outputChannel: this._outputChannel,
    };
    try {
      await p4fixJob(context, changelistId, jobId, p4Options, true);
      await this.refresh();
    } catch (error: any) {
      this._outputChannel.appendLine(
        `SCM Provider: Error unfixing job ${jobId} for change ${changelistId}: ${error.message}`,
      );
      throw error;
    }
  }

  public async getAnnotations(
    resourceUri: vscode.Uri,
  ): Promise<P4Annotation[]> {
    this._outputChannel.appendLine(
      `SCM Provider: Requesting annotations for ${resourceUri.fsPath}.`,
    );
    const p4Options = getP4OptionsFromConfig(resourceUri);
    const context: P4CommandContext = {
      execute: this._perforceService.execute.bind(this._perforceService),
      outputChannel: this._outputChannel,
    };
    try {
      return await p4annotate(context, resourceUri.fsPath, p4Options);
    } catch (error: any) {
      this._outputChannel.appendLine(
        `SCM Provider: Error getting annotations for ${resourceUri.fsPath}: ${error.message}`,
      );
      throw error;
    }
  }

  public async resolveFile(
    resourceUri: vscode.Uri,
    resolveFlags: string[],
  ): Promise<string> {
    this._outputChannel.appendLine(
      `SCM Provider: Requesting resolve for ${resourceUri.fsPath} with flags: ${resolveFlags.join(" ")}`,
    );
    const p4Options = getP4OptionsFromConfig(this.rootUri);
    const context: P4CommandContext = {
      execute: this._perforceService.execute.bind(this._perforceService),
      outputChannel: this._outputChannel,
    };
    try {
      // Pass specific file path
      const output = await p4resolve(
        context,
        resolveFlags,
        [resourceUri.fsPath],
        p4Options,
      );
      await this.refresh(); // State changes after resolve
      return output;
    } catch (error: any) {
      this._outputChannel.appendLine(
        `SCM Provider: Error during p4resolve for ${resourceUri.fsPath}: ${error.message}`,
      );
      await this.refresh(); // Refresh even on error
      throw error;
    }
  }

  public async getChanges(args: string[]): Promise<P4ChangeSummary[]> {
    this._outputChannel.appendLine(
      `SCM Provider: Requesting changes list with args: ${args.join(" ")}`,
    );
    const p4Options = getP4OptionsFromConfig(this.rootUri);
    const context: P4CommandContext = {
      execute: this._perforceService.execute.bind(this._perforceService),
      outputChannel: this._outputChannel,
    };
    try {
      return await p4changes(context, p4Options, args);
    } catch (error: any) {
      this._outputChannel.appendLine(
        `SCM Provider: Error getting changes list: ${error.message}`,
      );
      throw error;
    }
  }

  public async getJobs(args: string[]): Promise<P4JobSummary[]> {
    this._outputChannel.appendLine(
      `SCM Provider: Requesting jobs list with args: ${args.join(" ")}`,
    );
    const p4Options = getP4OptionsFromConfig(this.rootUri);
    const context: P4CommandContext = {
      execute: this._perforceService.execute.bind(this._perforceService),
      outputChannel: this._outputChannel,
    };
    try {
      return await p4jobs(context, p4Options, args);
    } catch (error: any) {
      this._outputChannel.appendLine(
        `SCM Provider: Error getting jobs list: ${error.message}`,
      );
      throw error;
    }
  }

  public async getJobSpec(jobId: string): Promise<string> {
    this._outputChannel.appendLine(
      `SCM Provider: Requesting job spec for ${jobId}.`,
    );
    const p4Options = getP4OptionsFromConfig(this.rootUri);
    const context: P4CommandContext = {
      execute: this._perforceService.execute.bind(this._perforceService),
      outputChannel: this._outputChannel,
    };
    try {
      return await p4job(context, jobId, p4Options);
    } catch (error: any) {
      this._outputChannel.appendLine(
        `SCM Provider: Error getting job spec for ${jobId}: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Retrieves and parses the output of 'p4 info' for this provider's context.
   * @returns A Promise resolving to a P4Info object containing parsed info.
   * @throws An error if 'p4 info' command fails or parsing is unsuccessful.
   */
  public async getInfo(): Promise<P4Info> {
    this._outputChannel.appendLine(
      `SCM Provider: Requesting p4 info for ${this.rootUri.fsPath}`,
    );
    const p4Options = getP4OptionsFromConfig(this.rootUri);
    const context: P4CommandContext = {
      execute: this._perforceService.execute.bind(this._perforceService),
      outputChannel: this._outputChannel,
    };

    try {
      // Use execute directly, no tagged output needed/helpful for p4 info
      const result = await this._perforceService.execute(
        "info",
        [],
        p4Options,
        false,
      ); // Explicitly set tagged=false
      const stdout = result.stdout;

      // Parse the output using regex
      const info: Partial<P4Info> = {}; // Use Partial to build the object

      const userNameMatch = stdout.match(/^User name:\s*(.*)$/im);
      if (userNameMatch) {
        info.userName = userNameMatch[1].trim();
      }

      const clientNameMatch = stdout.match(/^Client name:\s*(.*)$/im);
      if (clientNameMatch) {
        info.clientName = clientNameMatch[1].trim();
      }

      const clientHostMatch = stdout.match(/^Client host:\s*(.*)$/im);
      if (clientHostMatch) {
        info.clientHost = clientHostMatch[1].trim();
      }

      const clientRootMatch = stdout.match(/^Client root:\s*(.*)$/im);
      if (clientRootMatch) {
        info.clientRoot = clientRootMatch[1].trim();
      }

      const serverAddressMatch = stdout.match(/^Server address:\s*(.*)$/im);
      if (serverAddressMatch) {
        info.serverAddress = serverAddressMatch[1].trim();
      }

      const serverVersionMatch = stdout.match(/^Server version:\s*(.*)$/im);
      if (serverVersionMatch) {
        info.serverVersion = serverVersionMatch[1].trim();
      }

      const serverLicenseMatch = stdout.match(/^Server license:\s*(.*)$/im);
      if (serverLicenseMatch) {
        info.serverLicense = serverLicenseMatch[1].trim();
      }

      const caseHandlingMatch = stdout.match(/^Case Handling:\s*(.*)$/im);
      if (caseHandlingMatch) {
        info.caseHandling = caseHandlingMatch[1].trim();
      }

      // Validate required fields
      if (!info.userName || !info.clientName) {
        this._outputChannel.appendLine(
          ` Error parsing p4 info output: Missing required fields (userName, clientName). Output:\n${stdout}`,
        );
        throw new Error(
          "Failed to parse essential fields from p4 info output.",
        );
      }

      this._outputChannel.appendLine(
        ` Parsed p4 info: User=${info.userName}, Client=${info.clientName}`,
      );
      return info as P4Info; // Cast to P4Info after validation
    } catch (error: any) {
      // Log the original error and re-throw
      this._outputChannel.appendLine(
        `SCM Provider: Error running/parsing p4 info: ${error.message}`,
      );
      // The execute method should throw on command failure, so we just re-throw here
      throw error;
    }
  }

  dispose() {
    this._disposables.forEach((d) => d.dispose());
    if (this._scm) {
      this._scm.dispose();
    }
    this._repositoryStateManager.dispose();
    this._outputChannel.appendLine(
      `Disposing Perforce SCM Provider for ${this._scm?.label ?? "(unknown)"}`,
    );
  }
}
