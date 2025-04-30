// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from "vscode";
import { PerforceService } from "./PerforceService";
import { getP4OptionsFromConfig } from "./p4/p4Utils";
// import { RepositoryStateManager } from './RepositoryStateManager'; // Manager is now part of SCMProvider
import { PerforceSCMProvider } from "./PerforceSCMProvider";
// Import necessary command wrappers
import {
  p4edit,
  p4revert,
  p4add,
  p4delete,
  p4sync,
  p4move,
} from "./p4/fileCommands";
import {
  p4newChangeSpec,
  p4editChangeSpec,
  p4saveChangeSpec,
  p4submit,
  p4describe,
} from "./p4/changelistCommands";
import { p4shelve, p4unshelve } from "./p4/shelveCommands";
import { p4fixJob } from "./p4/jobCommands";
import { p4annotate, p4filelog } from "./p4/historyCommands";
import { P4JobSummary, P4ChangeSummary, P4Annotation } from "./p4/p4Types"; // Import new types

let perforceService: PerforceService; // Shared service
// Map to store active SCM Providers, keyed by root URI string
const scmProviders = new Map<string, PerforceSCMProvider>();
let outputChannel: vscode.OutputChannel;
let extensionContext: vscode.ExtensionContext; // Store context for disposables
let p4StatusBarItem: vscode.StatusBarItem;

// Annotation variables
let p4AnnotationDecorationType: vscode.TextEditorDecorationType;
const annotationCache = new Map<string, P4Annotation[]>(); // Cache annotations per URI string
let annotationRequestPending: boolean = false; // Prevent concurrent annotate requests

// This method is called when your extension is activated
export async function activate(context: vscode.ExtensionContext) {
  extensionContext = context;

  // Create output channel (shared)
  outputChannel = vscode.window.createOutputChannel("Perforce");
  context.subscriptions.push(outputChannel);
  outputChannel.appendLine("Activating Perforce extension...");

  // Initialize shared Perforce service
  perforceService = new PerforceService(outputChannel);
  context.subscriptions.push(perforceService);

  outputChannel.appendLine("Shared Perforce service initialized.");

  // Determine activation mode
  const activationMode = vscode.workspace
    .getConfiguration("perforce")
    .get<string>("activationMode", "autodetect");
  outputChannel.appendLine(`Activation mode: ${activationMode}`);

  switch (activationMode) {
    case "always":
    case "autodetect": // For now, treat autodetect the same as always for initial scan
      await detectAndInitializePerforceProviders();
      break;
    case "off":
      outputChannel.appendLine(
        "Perforce activation is set to 'off'. Extension will not activate SCM features.",
      );
      vscode.commands.executeCommand(
        "setContext",
        "perforce.activation.status",
        "off",
      ); // For welcome view
      return; // Do nothing further
  }

  // Listen for workspace folder changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(handleWorkspaceFolderChange),
  );

  // Register global commands (if any remain)
  // Example: Show Output command
  context.subscriptions.push(
    vscode.commands.registerCommand("perforce.showOutput", () => {
      outputChannel.show();
    }),
  );

  // Register SCM-related commands
  registerSCMCommands(context);

  // Register global action commands
  context.subscriptions.push(
    vscode.commands.registerCommand("perforce.login", async () => {
      outputChannel.appendLine("Command 'perforce.login' triggered.");

      // Check if any providers are active to get context/options
      if (scmProviders.size === 0) {
        vscode.window.showWarningMessage(
          "No active Perforce workspace found. Cannot determine context for login.",
        );
        return;
      }
      // Use options from the first provider for context (e.g., P4PORT, P4USER might be relevant)
      const firstProvider = scmProviders.values().next()
        .value as PerforceSCMProvider;
      const p4Options = getP4OptionsFromConfig(firstProvider.rootUri);

      const password = await vscode.window.showInputBox({
        prompt: "Enter Perforce Password",
        password: true,
        ignoreFocusOut: true,
        placeHolder: "Password for p4 login",
      });

      if (password === undefined) {
        // Check for undefined (user cancelled) rather than just falsy
        outputChannel.appendLine("Login cancelled by user.");
        return;
      }

      vscode.window.setStatusBarMessage("Perforce: Logging in...", 2000);

      try {
        // Pass password via stdin
        const result = await perforceService.execute(
          "login",
          [],
          p4Options,
          false,
          password,
        );
        outputChannel.appendLine(`p4 login stdout: ${result.stdout}`);
        outputChannel.appendLine(`p4 login stderr: ${result.stderr}`);

        // Check stdout for success message (more reliable than lack of stderr)
        if (
          result.stdout.includes("User logged in") ||
          result.stdout.includes("Ticket expires")
        ) {
          vscode.window.showInformationMessage("Perforce login successful.");
        } else if (result.stderr) {
          // Handle cases where login might succeed but have stderr warnings?
          // For now, assume stderr means a problem potentially occurred
          vscode.window.showWarningMessage(
            `Perforce login may have issues: ${result.stderr}`,
          );
        } else {
          // Unexpected output
          vscode.window.showWarningMessage(
            `Perforce login completed with unexpected output. Check Perforce output channel.`,
          );
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        outputChannel.appendLine(`Error during p4 login: ${errorMsg}`);
        // Display a more user-friendly message based on common errors
        if (errorMsg.includes("invalid password")) {
          vscode.window.showErrorMessage(
            "Perforce login failed: Invalid password.",
          );
        } else if (errorMsg.includes("connect to server failed")) {
          vscode.window.showErrorMessage(
            "Perforce login failed: Could not connect to server.",
          );
        } else {
          vscode.window.showErrorMessage(`Perforce login failed: ${errorMsg}`);
        }
      } finally {
        // Always update status bar after login attempt
        await updateStatusBarItem();
      }
    }),
  );

  // Placeholder context for welcome views
  if (scmProviders.size > 0) {
    vscode.commands.executeCommand(
      "setContext",
      "perforce.activation.hasScmProvider",
      true,
    );
    vscode.commands.executeCommand(
      "setContext",
      "perforce.activation.status",
      "complete",
    ); // Or update based on actual detection
  } else if (activationMode !== "off") {
    vscode.commands.executeCommand(
      "setContext",
      "perforce.activation.status",
      "noClientFound",
    ); // Example status
  }

  outputChannel.appendLine("Perforce extension activation sequence finished.");

  // Create Perforce status bar item
  p4StatusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100,
  ); // Align left, priority 100
  context.subscriptions.push(p4StatusBarItem); // Add to subscriptions for disposal
  p4StatusBarItem.command = "perforce.showOutput"; // Example: click to show output
  updateStatusBarItem(); // Call a new function to set initial/current state
  p4StatusBarItem.show(); // Make it visible

  // Define annotation decoration type
  p4AnnotationDecorationType = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    gutterIconSize: "contain",
    light: {
      after: {
        color: new vscode.ThemeColor("editorLineNumber.foreground"), // Use theme color
        margin: "0 0 0 1em", // Add some margin
        fontStyle: "italic",
      },
    },
    dark: {
      after: {
        color: new vscode.ThemeColor("editorLineNumber.foreground"), // Use theme color
        margin: "0 0 0 1em",
        fontStyle: "italic",
      },
    },
  });
  context.subscriptions.push(p4AnnotationDecorationType);

  // Listen for active editor changes to update annotations
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) {
        triggerAnnotationUpdate(editor);
      }
    }),
  );

  // Optional: Listen for document saves to refresh annotations
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((document) => {
      const config = vscode.workspace.getConfiguration(
        "perforce",
        document.uri,
      );
      const enabled = config.get<boolean>("annotations.enabled", true);
      const refreshOnSave = config.get<boolean>(
        "annotations.refreshOnSave",
        false,
      );

      if (enabled && refreshOnSave) {
        outputChannel.appendLine(
          `Document saved, refreshing annotations for: ${document.uri.fsPath}`,
        );
        annotationCache.delete(document.uri.toString()); // Clear cache for this file
        // Find the visible editor for this document and trigger update
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor && activeEditor.document === document) {
          triggerAnnotationUpdate(activeEditor);
        }
      }
    }),
  );

  // Register annotation refresh command
  context.subscriptions.push(
    vscode.commands.registerCommand("perforce.refreshAnnotations", () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        outputChannel.appendLine(
          `Command 'perforce.refreshAnnotations' triggered for: ${editor.document.uri.fsPath}`,
        );
        annotationCache.delete(editor.document.uri.toString()); // Clear cache
        triggerAnnotationUpdate(editor);
      } else {
        vscode.window.showInformationMessage(
          "Open a file editor to refresh annotations.",
        );
      }
    }),
  );

  // Initial annotation update for the editor active at startup
  if (vscode.window.activeTextEditor) {
    triggerAnnotationUpdate(vscode.window.activeTextEditor);
  }
}

async function detectAndInitializePerforceProviders(): Promise<void> {
  outputChannel.appendLine("Detecting Perforce workspaces...");
  const potentialRoots = await detectPerforceWorkspaces();

  if (!potentialRoots || potentialRoots.length === 0) {
    outputChannel.appendLine("No potential Perforce workspace roots found.");
    vscode.commands.executeCommand(
      "setContext",
      "perforce.activation.status",
      vscode.workspace.workspaceFolders ? "noClientFound" : "noworkspace",
    );
    return;
  }

  outputChannel.appendLine(
    `Found ${potentialRoots.length} potential roots. Initializing SCM providers...`,
  );
  for (const rootUri of potentialRoots) {
    initializeProvider(rootUri);
  }
}

/**
 * Placeholder function to detect Perforce workspaces.
 * Currently just returns all VS Code workspace folders.
 * TODO: Implement actual detection logic (e.g., run `p4 info`, check for .p4config).
 */
async function detectPerforceWorkspaces(): Promise<vscode.Uri[]> {
  outputChannel.appendLine(
    "Running p4 info for workspace folders to detect client roots...",
  );
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) {
    outputChannel.appendLine("No workspace folders open.");
    return [];
  }

  // Use a Map to store unique client roots found, mapping root path string to workspace folder URI
  const detectedRoots = new Map<string, vscode.Uri>();

  for (const folder of workspaceFolders) {
    const folderUri = folder.uri;
    outputChannel.appendLine(`Checking folder: ${folderUri.fsPath}`);
    const p4Options = getP4OptionsFromConfig(folderUri);

    try {
      // Execute 'p4 info' for this folder
      // We don't need tagged output here, just parsing the text
      const result = await perforceService.execute("info", [], p4Options);
      const stdout = result.stdout;

      // Basic parsing for Client root
      const clientRootMatch = stdout.match(/^Client root:\s*(.*)$/im);
      if (clientRootMatch && clientRootMatch[1]) {
        const clientRootPath = clientRootMatch[1].trim();
        outputChannel.appendLine(
          `  Found client root: ${clientRootPath} for folder ${folderUri.fsPath}`,
        );

        // Check if we've already found this client root via another folder
        if (!detectedRoots.has(clientRootPath)) {
          // Store the workspace folder URI as the context for this client root
          // We might refine this later to use the actual clientRootPath if needed,
          // but the SCM provider needs a workspace folder URI.
          detectedRoots.set(clientRootPath, folderUri);
          outputChannel.appendLine(
            `  Added unique root mapping: ${clientRootPath} -> ${folderUri.fsPath}`,
          );
        } else {
          outputChannel.appendLine(
            `  Client root ${clientRootPath} already mapped by another folder.`,
          );
        }
      } else {
        outputChannel.appendLine(
          `  Could not find 'Client root:' in p4 info output for ${folderUri.fsPath}.`,
        );
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      // Log expected errors (like not logged in, not a client) differently?
      if (
        errorMsg.includes("client unknown") ||
        errorMsg.includes("Client specification unknown")
      ) {
        outputChannel.appendLine(
          `  Folder ${folderUri.fsPath} does not appear to be in a client workspace.`,
        );
      } else if (errorMsg.includes("not logged in")) {
        outputChannel.appendLine(
          `  Cannot get info for ${folderUri.fsPath}: Not logged in.`,
        );
        // TODO: Potentially trigger login UI?
      } else {
        outputChannel.appendLine(
          `  Error running p4 info for ${folderUri.fsPath}: ${errorMsg}`,
        );
      }
    }
  }

  const uniqueFolderUris = Array.from(detectedRoots.values());
  outputChannel.appendLine(
    `Detection finished. Found ${uniqueFolderUris.length} unique workspace roots containing Perforce clients.`,
  );
  return uniqueFolderUris;
}

function initializeProvider(rootUri: vscode.Uri): void {
  const rootUriString = rootUri.toString();
  if (!scmProviders.has(rootUriString)) {
    outputChannel.appendLine(
      `Initializing Perforce SCM Provider for root: ${rootUri.fsPath}`,
    );
    try {
      // Pass the shared output channel
      const provider = new PerforceSCMProvider(rootUri, outputChannel);
      scmProviders.set(rootUriString, provider);
      // Add provider to context subscriptions for disposal
      extensionContext.subscriptions.push(provider);
      outputChannel.appendLine(
        `Successfully initialized provider for: ${rootUri.fsPath}`,
      );
      vscode.commands.executeCommand(
        "setContext",
        "perforce.activation.hasScmProvider",
        true,
      );
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      outputChannel.appendLine(
        `Error initializing provider for ${rootUri.fsPath}: ${errorMsg}`,
      );
      vscode.window.showErrorMessage(
        `Failed to initialize Perforce for ${rootUri.fsPath}: ${errorMsg}`,
      );
    }
  } else {
    outputChannel.appendLine(
      `Provider already exists for root: ${rootUri.fsPath}`,
    );
  }
}

function disposeProvider(rootUri: vscode.Uri): void {
  const rootUriString = rootUri.toString();
  const provider = scmProviders.get(rootUriString);
  if (provider) {
    outputChannel.appendLine(
      `Disposing Perforce SCM Provider for root: ${rootUri.fsPath}`,
    );
    provider.dispose(); // Call the provider's dispose method
    scmProviders.delete(rootUriString);
    // Also remove from context.subscriptions? This is tricky if added there.
    // It might be simpler to let the extension deactivation handle final cleanup.
  }
  if (scmProviders.size === 0) {
    vscode.commands.executeCommand(
      "setContext",
      "perforce.activation.hasScmProvider",
      false,
    );
  }
}

function handleWorkspaceFolderChange(
  event: vscode.WorkspaceFoldersChangeEvent,
): void {
  outputChannel.appendLine("Workspace folders changed.");
  const activationMode = vscode.workspace
    .getConfiguration("perforce")
    .get<string>("activationMode", "autodetect");
  if (activationMode === "off") {
    return;
  }

  // Initialize providers for added folders
  for (const folder of event.added) {
    outputChannel.appendLine(`Workspace folder added: ${folder.uri.fsPath}`);
    // TODO: Add detection logic here? For now, just initialize.
    initializeProvider(folder.uri);
  }

  // Dispose providers for removed folders
  for (const folder of event.removed) {
    outputChannel.appendLine(`Workspace folder removed: ${folder.uri.fsPath}`);
    disposeProvider(folder.uri);
  }
}

// Helper function to find the SCM provider responsible for a given file URI
function getProviderForUri(uri: vscode.Uri): PerforceSCMProvider | undefined {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
  if (!workspaceFolder) {
    outputChannel.appendLine(
      `Could not find workspace folder for URI: ${uri.fsPath}`,
    );
    return undefined;
  }
  // Assuming the provider is stored keyed by the workspace folder URI string
  const provider = scmProviders.get(workspaceFolder.uri.toString());
  if (!provider) {
    outputChannel.appendLine(
      `No active Perforce SCM Provider found for workspace: ${workspaceFolder.uri.fsPath}`,
    );
  }
  return provider;
}

// Helper function to run a command for multiple resources sequentially
async function runCommandOnResources(
  commandName: string,
  resources: vscode.SourceControlResourceState[],
  providerAction: (
    provider: PerforceSCMProvider,
    uri: vscode.Uri,
  ) => Promise<any>,
  errorMessagePrefix: string,
  successMessagePrefix: string,
): Promise<void> {
  if (!resources || resources.length === 0) {
    vscode.window.showWarningMessage(
      `No resources selected for ${commandName}.`,
    );
    return;
  }
  outputChannel.appendLine(
    `Command '${commandName}' triggered for ${resources.length} resource(s).`,
  );
  let successCount = 0;
  let firstError: Error | null = null;

  for (const resource of resources) {
    const provider = getProviderForUri(resource.resourceUri);
    if (provider) {
      try {
        await providerAction(provider, resource.resourceUri);
        successCount++;
      } catch (error: any) {
        outputChannel.appendLine(
          `  Error processing ${resource.resourceUri.fsPath} for ${commandName}: ${error.message}`,
        );
        if (!firstError) {
          firstError = error; // Store the first error encountered
        }
      }
    } else {
      vscode.window.showWarningMessage(
        `Could not find Perforce provider for ${vscode.workspace.asRelativePath(resource.resourceUri)}`,
      );
    }
  }

  if (firstError) {
    vscode.window.showErrorMessage(
      `${errorMessagePrefix} failed for some resources. Check output channel for details. First error: ${firstError.message}`,
    );
  } else if (successCount > 0) {
    vscode.window.setStatusBarMessage(
      `Perforce: ${successMessagePrefix} (${successCount} resource${successCount > 1 ? "s" : ""})`,
      3000,
    );
  } else {
    // No successes, no errors reported? Likely provider issue or empty resource list already handled.
    outputChannel.appendLine(
      `Command '${commandName}' completed with no action taken or errors reported.`,
    );
  }
}

// Register commands that interact with the SCM providers
function registerSCMCommands(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "perforce.editSelected",
      async (...resourceStates: vscode.SourceControlResourceState[]) => {
        await runCommandOnResources(
          "editSelected",
          resourceStates,
          (provider, uri) => provider.editFile(uri),
          "Edit",
          "Opened for edit",
        );
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "perforce.revertSelected",
      async (...resourceStates: vscode.SourceControlResourceState[]) => {
        if (!resourceStates || resourceStates.length === 0) {
          return;
        }
        const confirmation = await vscode.window.showWarningMessage(
          `Are you sure you want to revert ${resourceStates.length} file(s)? This will discard local changes.`,
          { modal: true },
          "Revert",
        );
        if (confirmation !== "Revert") {
          outputChannel.appendLine("Revert cancelled by user.");
          return;
        }

        await runCommandOnResources(
          "revertSelected",
          resourceStates,
          (provider, uri) => provider.revertFile(uri),
          "Revert",
          "Reverted",
        );
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "perforce.addSelected",
      async (...resourceStates: vscode.SourceControlResourceState[]) => {
        await runCommandOnResources(
          "addSelected",
          resourceStates,
          (provider, uri) => provider.addFile(uri),
          "Add",
          "Opened for add",
        );
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "perforce.deleteSelected",
      async (...resourceStates: vscode.SourceControlResourceState[]) => {
        if (!resourceStates || resourceStates.length === 0) {
          return;
        }
        const confirmation = await vscode.window.showWarningMessage(
          `Are you sure you want to mark ${resourceStates.length} file(s) for delete? This does NOT delete the local file immediately.`,
          { modal: true },
          "Mark for Delete",
        );
        if (confirmation !== "Mark for Delete") {
          outputChannel.appendLine("Delete cancelled by user.");
          return;
        }

        await runCommandOnResources(
          "deleteSelected",
          resourceStates,
          (provider, uri) => provider.deleteFile(uri),
          "Delete",
          "Marked for delete",
        );
      },
    ),
  );

  // --- Sync ---
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "perforce.syncSelected",
      async (...resourceStates: vscode.SourceControlResourceState[]) => {
        if (!resourceStates || resourceStates.length === 0) {
          vscode.window.showWarningMessage("No file selected to sync.");
          return;
        }
        // TODO: Maybe confirm sync? Syncing can take time or overwrite changes if not careful.
        const uris = resourceStates.map((r) => r.resourceUri);
        // Sync might affect multiple providers if selection spans roots
        const providers = new Map<PerforceSCMProvider, vscode.Uri[]>();
        for (const uri of uris) {
          const provider = getProviderForUri(uri);
          if (provider) {
            if (!providers.has(provider)) {
              providers.set(provider, []);
            }
            providers.get(provider)?.push(uri);
          } else {
            vscode.window.showWarningMessage(
              `Could not find Perforce provider for ${vscode.workspace.asRelativePath(uri)}`,
            );
          }
        }

        let success = true;
        for (const [provider, providerUris] of providers.entries()) {
          try {
            await provider.syncFiles(providerUris);
          } catch (error: any) {
            success = false;
            vscode.window.showErrorMessage(
              `Perforce: Sync failed for ${provider.rootUri.fsPath}. ${error.message}`,
            );
            outputChannel.appendLine(
              `  Error syncing files in ${provider.rootUri.fsPath}: ${error.message}`,
            );
          }
        }
        if (success) {
          vscode.window.setStatusBarMessage(
            `Perforce: Sync command finished for selected file(s).`,
            3000,
          );
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("perforce.syncAll", async () => {
      // Sync all roots managed by active providers
      outputChannel.appendLine(`Command 'perforce.syncAll' triggered.`);
      const confirmation = await vscode.window.showQuickPick(["Yes", "No"], {
        placeHolder:
          "Sync all files in all detected Perforce clients? This might take time.",
      });
      if (confirmation !== "Yes") {
        outputChannel.appendLine("Sync All cancelled by user.");
        return;
      }

      let success = true;
      if (scmProviders.size === 0) {
        vscode.window.showInformationMessage(
          "No active Perforce workspaces found to sync.",
        );
        return;
      }
      for (const provider of scmProviders.values()) {
        try {
          vscode.window.setStatusBarMessage(
            `Perforce: Syncing ${provider.rootUri.fsPath}...`,
            5000,
          );
          await provider.syncFiles([]); // Pass empty array to sync all
        } catch (error: any) {
          success = false;
          vscode.window.showErrorMessage(
            `Perforce: Sync failed for ${provider.rootUri.fsPath}. ${error.message}`,
          );
          outputChannel.appendLine(
            `  Error syncing all files in ${provider.rootUri.fsPath}: ${error.message}`,
          );
        }
      }
      if (success) {
        vscode.window.setStatusBarMessage(
          `Perforce: Sync all command finished.`,
          3000,
        );
      }
    }),
  );

  // --- Move ---
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "perforce.moveSelected",
      async (resourceState: vscode.SourceControlResourceState) => {
        if (!resourceState) {
          vscode.window.showWarningMessage(
            "Select a single file in the Source Control view to move/rename.",
          );
          return;
        }
        const provider = getProviderForUri(resourceState.resourceUri);
        if (!provider) {
          vscode.window.showWarningMessage(
            `Could not find Perforce provider for ${vscode.workspace.asRelativePath(resourceState.resourceUri)}`,
          );
          return;
        }

        const sourceUri = resourceState.resourceUri;
        // Prompt for target using showSaveDialog for better UX
        const targetUri = await vscode.window.showSaveDialog({
          defaultUri: sourceUri, // Start near the original file
          title: `Choose new location/name for ${vscode.workspace.asRelativePath(sourceUri)}`,
        });

        if (!targetUri) {
          outputChannel.appendLine("Move cancelled by user.");
          return;
        }

        // Basic check if source and target are the same
        if (sourceUri.fsPath === targetUri.fsPath) {
          vscode.window.showInformationMessage(
            "Source and target paths are the same. No move necessary.",
          );
          return;
        }

        outputChannel.appendLine(
          `Command 'perforce.moveSelected' triggered: ${sourceUri.fsPath} -> ${targetUri.fsPath}`,
        );
        try {
          await provider.moveFile(sourceUri, targetUri);
          vscode.window.setStatusBarMessage(
            `Perforce: Moved ${vscode.workspace.asRelativePath(sourceUri)} to ${vscode.workspace.asRelativePath(targetUri)}`,
            4000,
          );
        } catch (error: any) {
          vscode.window.showErrorMessage(
            `Perforce: Failed to move ${vscode.workspace.asRelativePath(sourceUri)}. ${error.message}`,
          );
          outputChannel.appendLine(
            `  Error moving ${sourceUri.fsPath}: ${error.message}`,
          );
        }
      },
    ),
  );

  // --- Changelist Specs ---
  context.subscriptions.push(
    vscode.commands.registerCommand("perforce.newChangelist", async () => {
      outputChannel.appendLine(`Command 'perforce.newChangelist' triggered.`);
      // Find *any* active provider to get the spec from, assuming spec format is universal
      const provider =
        scmProviders.size > 0 ? scmProviders.values().next().value : undefined;
      if (!provider) {
        vscode.window.showWarningMessage(
          "No active Perforce workspace found to create a new changelist spec.",
        );
        return;
      }
      try {
        const spec = await provider.getNewChangeSpec();
        const document = await vscode.workspace.openTextDocument({
          content: spec,
          language: "perforce-spec",
        }); // Use a custom language ID
        await vscode.window.showTextDocument(document);
        vscode.window.setStatusBarMessage(
          "Perforce: Opened new changelist spec. Use 'Save Active Changelist Spec' command to create.",
          5000,
        );
      } catch (error: any) {
        vscode.window.showErrorMessage(
          `Perforce: Failed to get new changelist spec. ${error.message}`,
        );
        outputChannel.appendLine(
          `  Error getting new change spec: ${error.message}`,
        );
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "perforce.editChangelistSpec",
      async (resourceGroup?: vscode.SourceControlResourceGroup) => {
        outputChannel.appendLine(
          `Command 'perforce.editChangelistSpec' triggered.`,
        );
        let changelistId: string | undefined = resourceGroup?.id;

        if (!changelistId) {
          // If not called from context menu, prompt for changelist ID
          changelistId = await vscode.window.showInputBox({
            prompt: "Enter pending changelist number to edit:",
            ignoreFocusOut: true,
          });
          if (!changelistId) {
            outputChannel.appendLine("Edit spec cancelled.");
            return;
          }
        }

        if (changelistId === "default") {
          vscode.window.showInformationMessage(
            'Cannot directly edit the spec for the default changelist this way. Use "New Changelist" instead.',
          );
          return;
        }

        // Find *any* active provider
        const provider =
          scmProviders.size > 0
            ? scmProviders.values().next().value
            : undefined;
        if (!provider) {
          vscode.window.showWarningMessage(
            "No active Perforce workspace found to edit changelist spec.",
          );
          return;
        }

        try {
          const spec = await provider.getChangeSpec(changelistId);
          const document = await vscode.workspace.openTextDocument({
            content: spec,
            language: "perforce-spec",
          });
          await vscode.window.showTextDocument(document);
          vscode.window.setStatusBarMessage(
            `Perforce: Opened spec for changelist ${changelistId}. Use \'Save Active Changelist Spec\' command to update.`,
            5000,
          );
        } catch (error: any) {
          vscode.window.showErrorMessage(
            `Perforce: Failed to get spec for changelist ${changelistId}. ${error.message}`,
          );
          outputChannel.appendLine(
            `  Error getting change spec for ${changelistId}: ${error.message}`,
          );
        }
      },
    ),
  );

  // Command to save the currently active spec document
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "perforce.saveActiveChangelistSpec",
      async () => {
        outputChannel.appendLine(
          `Command 'perforce.saveActiveChangelistSpec' triggered.`,
        );
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== "perforce-spec") {
          vscode.window.showWarningMessage(
            "The active editor does not contain a Perforce changelist spec.",
          );
          return;
        }
        // Check if document is dirty (has unsaved changes in VS Code buffer)
        if (!editor.document.isDirty) {
          vscode.window.showInformationMessage(
            "Changelist spec has no unsaved changes.",
          );
          // Optionally still proceed? Or just return?
          // return;
        }

        const spec = editor.document.getText();
        // Find *any* active provider
        const provider =
          scmProviders.size > 0
            ? scmProviders.values().next().value
            : undefined;
        if (!provider) {
          vscode.window.showWarningMessage(
            "No active Perforce workspace found to save changelist spec.",
          );
          return;
        }
        try {
          // Mark document as no longer dirty immediately before saving
          await editor.document.save(); // Save the VS Code buffer first
          const savedChangeId = await provider.saveChangeSpec(spec);
          vscode.window.showInformationMessage(
            `Perforce: Changelist ${savedChangeId} saved successfully.`,
          );
          // Optionally close the spec document after successful save?
          // await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        } catch (error: any) {
          vscode.window.showErrorMessage(
            `Perforce: Failed to save changelist spec. ${error.message}`,
          );
          outputChannel.appendLine(
            `  Error saving change spec: ${error.message}`,
          );
        }
      },
    ),
  );

  // --- Submit ---
  context.subscriptions.push(
    vscode.commands.registerCommand("perforce.submitDefault", async () => {
      outputChannel.appendLine(`Command 'perforce.submitDefault' triggered.`);
      // Find *any* active provider to initiate submit
      const provider =
        scmProviders.size > 0 ? scmProviders.values().next().value : undefined;
      if (!provider) {
        vscode.window.showWarningMessage(
          "No active Perforce workspace found to submit default changelist.",
        );
        return;
      }
      // Get description from the SCM input box for the *first* provider found
      // This assumes the user is interacting with one main SCM view typically
      const description = provider.getScmInputBoxMessage();

      if (!description?.trim()) {
        const proceed = await vscode.window.showQuickPick(["Yes", "No"], {
          placeHolder: "Submit default changelist with no description?",
          ignoreFocusOut: true,
        });
        if (proceed !== "Yes") {
          outputChannel.appendLine("Submit default cancelled.");
          return;
        }
      }

      try {
        // Pass description to the submit method
        const result = await provider.submitChange(undefined, description); // Undefined CL id means default
        if (result?.submittedChange) {
          vscode.window.showInformationMessage(
            `Perforce: Submitted changelist ${result.submittedChange}.`,
          );
          provider.clearScmInputBoxMessage(); // Clear input box on successful submit
        } else {
          vscode.window.showInformationMessage(
            `Perforce: Submit process completed. No change number reported (may be empty or already submitted).`,
          );
        }
      } catch (error: any) {
        vscode.window.showErrorMessage(
          `Perforce: Failed to submit default changelist. ${error.message}`,
        );
        outputChannel.appendLine(
          `  Error submitting default change: ${error.message}`,
        );
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "perforce.submitSpecific",
      async (resourceGroup?: vscode.SourceControlResourceGroup) => {
        outputChannel.appendLine(
          `Command 'perforce.submitSpecific' triggered.`,
        );
        let changelistId: string | undefined = resourceGroup?.id;

        if (!changelistId) {
          changelistId = await vscode.window.showInputBox({
            prompt: "Enter pending changelist number to submit:",
            ignoreFocusOut: true,
          });
          if (!changelistId) {
            outputChannel.appendLine("Submit specific cancelled.");
            return;
          }
        }

        if (changelistId === "default") {
          vscode.commands.executeCommand("perforce.submitDefault");
          return;
        }

        // Find *any* active provider
        const provider =
          scmProviders.size > 0
            ? scmProviders.values().next().value
            : undefined;
        if (!provider) {
          vscode.window.showWarningMessage(
            "No active Perforce workspace found to submit changelist.",
          );
          return;
        }

        // TODO: Get description associated with this *specific* changelist if possible?
        // This might require reading the spec or relying on SCM state.
        // For now, we don't pass a description for specific submits via this command.

        try {
          const result = await provider.submitChange(changelistId);
          if (result?.submittedChange) {
            vscode.window.showInformationMessage(
              `Perforce: Submitted changelist ${result.submittedChange}.`,
            );
          } else {
            vscode.window.showInformationMessage(
              `Perforce: Submit process completed for ${changelistId}. No change number reported (may be empty or already submitted).`,
            );
          }
        } catch (error: any) {
          vscode.window.showErrorMessage(
            `Perforce: Failed to submit changelist ${changelistId}. ${error.message}`,
          );
          outputChannel.appendLine(
            `  Error submitting change ${changelistId}: ${error.message}`,
          );
        }
      },
    ),
  );

  // --- Describe ---
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "perforce.describeChange",
      async (resourceGroup?: vscode.SourceControlResourceGroup) => {
        outputChannel.appendLine(
          `Command 'perforce.describeChange' triggered.`,
        );
        let changelistId: string | undefined = resourceGroup?.id;

        if (!changelistId) {
          changelistId = await vscode.window.showInputBox({
            prompt: "Enter changelist number to describe:",
            ignoreFocusOut: true,
          });
          if (!changelistId) {
            outputChannel.appendLine("Describe cancelled.");
            return;
          }
        }

        // Find *any* active provider
        const provider =
          scmProviders.size > 0
            ? scmProviders.values().next().value
            : undefined;
        if (!provider) {
          vscode.window.showWarningMessage(
            "No active Perforce workspace found to describe changelist.",
          );
          return;
        }

        try {
          const description = await provider.describeChange(changelistId);
          if (description) {
            // Open description in a new read-only document
            const content =
              `Changelist: ${description.change}\n` +
              `User:       ${description.user}\n` +
              `Client:     ${description.client}\n` +
              `Date:       ${new Date(parseInt(description.time, 10) * 1000).toLocaleString()}\n` +
              `Status:     ${description.status}\n\n` +
              `${description.desc}\n\n` +
              `Affected files:\n${description.depotFile?.map((f, i) => `  ${f}#${description.rev?.[i]} (${description.action?.[i]})`).join("\n") ?? "  (None)"}`;

            const doc = await vscode.workspace.openTextDocument({
              content,
              language: "text",
            });
            await vscode.window.showTextDocument(doc, { preview: true }); // Open as preview
            vscode.window.setStatusBarMessage(
              `Perforce: Description for changelist ${changelistId} opened.`,
              5000,
            );
          } else {
            vscode.window.showInformationMessage(
              `Could not retrieve description for changelist ${changelistId}.`,
            );
          }
        } catch (error: any) {
          vscode.window.showErrorMessage(
            `Perforce: Failed to describe changelist ${changelistId}. ${error.message}`,
          );
          outputChannel.appendLine(
            `  Error describing change ${changelistId}: ${error.message}`,
          );
        }
      },
    ),
  );

  // --- Shelve / Unshelve ---
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "perforce.shelveSelectedChange",
      async (resourceGroup?: vscode.SourceControlResourceGroup) => {
        outputChannel.appendLine(
          `Command 'perforce.shelveSelectedChange' triggered.`,
        );
        let changelistId: string | undefined = resourceGroup?.id;

        if (!changelistId || changelistId === "default") {
          changelistId = await vscode.window.showInputBox({
            prompt:
              "Enter PENDING changelist number to shelve (cannot be default):",
            ignoreFocusOut: true,
          });
          if (!changelistId || changelistId === "default") {
            outputChannel.appendLine("Shelve cancelled or default specified.");
            vscode.window.showWarningMessage(
              "Shelving requires a specific pending changelist number (not default).",
            );
            return;
          }
        }
        // Find *any* active provider
        const provider =
          scmProviders.size > 0
            ? scmProviders.values().next().value
            : undefined;
        if (!provider) {
          vscode.window.showWarningMessage(
            "No active Perforce workspace found to shelve files.",
          );
          return;
        }

        try {
          await provider.shelveChange(changelistId);
          vscode.window.showInformationMessage(
            `Perforce: Files in changelist ${changelistId} shelved successfully.`,
          );
        } catch (error: any) {
          vscode.window.showErrorMessage(
            `Perforce: Failed to shelve files in ${changelistId}. ${error.message}`,
          );
          outputChannel.appendLine(
            `  Error shelving change ${changelistId}: ${error.message}`,
          );
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("perforce.unshelveSpecific", async () => {
      outputChannel.appendLine(
        `Command 'perforce.unshelveSpecific' triggered.`,
      );
      const shelvedChangeId = await vscode.window.showInputBox({
        prompt: "Enter SHELVED changelist number to unshelve:",
        ignoreFocusOut: true,
      });
      if (!shelvedChangeId) {
        outputChannel.appendLine("Unshelve cancelled.");
        return;
      }

      const targetChangeId = await vscode.window.showInputBox({
        prompt:
          "Enter target PENDING changelist number (leave blank for default):",
        ignoreFocusOut: true,
      });
      // targetChangeId can be undefined or empty string - pass undefined to provider

      // Find *any* active provider
      const provider =
        scmProviders.size > 0 ? scmProviders.values().next().value : undefined;
      if (!provider) {
        vscode.window.showWarningMessage(
          "No active Perforce workspace found to unshelve files.",
        );
        return;
      }

      try {
        await provider.unshelveChange(
          shelvedChangeId,
          targetChangeId ? targetChangeId : undefined,
        );
        vscode.window.showInformationMessage(
          `Perforce: Attempted to unshelve files from ${shelvedChangeId}. Check SCM view for results (resolve may be needed).`,
        );
      } catch (error: any) {
        vscode.window.showErrorMessage(
          `Perforce: Failed to unshelve files from ${shelvedChangeId}. ${error.message}`,
        );
        outputChannel.appendLine(
          `  Error unshelving change ${shelvedChangeId}: ${error.message}`,
        );
      }
    }),
  );

  // --- Fix Job ---
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "perforce.fixJob",
      async (resourceGroup?: vscode.SourceControlResourceGroup) => {
        outputChannel.appendLine(`Command 'perforce.fixJob' triggered.`);
        let changelistId: string | undefined = resourceGroup?.id;

        if (!changelistId || changelistId === "default") {
          changelistId = await vscode.window.showInputBox({
            prompt: "Enter pending changelist number to associate with job:",
            ignoreFocusOut: true,
          });
          if (!changelistId || changelistId === "default") {
            outputChannel.appendLine("Fix job cancelled.");
            return;
          }
        }
        const jobId = await vscode.window.showInputBox({
          prompt: `Enter Job ID to mark as fixed by changelist ${changelistId}:`,
          ignoreFocusOut: true,
        });
        if (!jobId) {
          outputChannel.appendLine("Fix job cancelled.");
          return;
        }

        // Find *any* active provider
        const provider =
          scmProviders.size > 0
            ? scmProviders.values().next().value
            : undefined;
        if (!provider) {
          vscode.window.showWarningMessage(
            "No active Perforce workspace found to fix job.",
          );
          return;
        }

        try {
          await provider.fixJob(changelistId, jobId);
          vscode.window.showInformationMessage(
            `Perforce: Job ${jobId} marked as fixed by changelist ${changelistId}.`,
          );
        } catch (error: any) {
          vscode.window.showErrorMessage(
            `Perforce: Failed to fix job ${jobId} for changelist ${changelistId}. ${error.message}`,
          );
          outputChannel.appendLine(
            `  Error fixing job ${jobId} for change ${changelistId}: ${error.message}`,
          );
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "perforce.unfixJob",
      async (resourceGroup?: vscode.SourceControlResourceGroup) => {
        outputChannel.appendLine(`Command 'perforce.unfixJob' triggered.`);
        let changelistId: string | undefined = resourceGroup?.id;

        if (!changelistId || changelistId === "default") {
          changelistId = await vscode.window.showInputBox({
            prompt: "Enter changelist number to remove job association from:",
            ignoreFocusOut: true,
          });
          if (!changelistId || changelistId === "default") {
            outputChannel.appendLine("Unfix job cancelled.");
            return;
          }
        }
        const jobId = await vscode.window.showInputBox({
          prompt: `Enter Job ID to un-fix from changelist ${changelistId}:`,
          ignoreFocusOut: true,
        });
        if (!jobId) {
          outputChannel.appendLine("Unfix job cancelled.");
          return;
        }

        // Find *any* active provider
        const provider =
          scmProviders.size > 0
            ? scmProviders.values().next().value
            : undefined;
        if (!provider) {
          vscode.window.showWarningMessage(
            "No active Perforce workspace found to unfix job.",
          );
          return;
        }

        try {
          await provider.unfixJob(changelistId, jobId);
          vscode.window.showInformationMessage(
            `Perforce: Job ${jobId} association removed from changelist ${changelistId}.`,
          );
        } catch (error: any) {
          vscode.window.showErrorMessage(
            `Perforce: Failed to unfix job ${jobId} for changelist ${changelistId}. ${error.message}`,
          );
          outputChannel.appendLine(
            `  Error unfixing job ${jobId} for change ${changelistId}: ${error.message}`,
          );
        }
      },
    ),
  );

  // --- Annotate ---
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "perforce.annotate",
      async (uri?: vscode.Uri) => {
        const targetUri = uri ?? vscode.window.activeTextEditor?.document.uri;
        if (!targetUri) {
          vscode.window.showWarningMessage(
            "Open a file editor or select a file to annotate.",
          );
          return;
        }
        outputChannel.appendLine(
          `Command 'perforce.annotate' triggered for ${targetUri.fsPath}`,
        );
        const provider = getProviderForUri(targetUri);
        if (!provider) {
          vscode.window.showWarningMessage(
            `Could not find Perforce provider for ${vscode.workspace.asRelativePath(targetUri)}`,
          );
          return;
        }

        try {
          vscode.window.setStatusBarMessage(
            `Perforce: Annotating ${vscode.workspace.asRelativePath(targetUri)}...`,
            5000,
          );
          const annotations = await provider.getAnnotations(targetUri);
          // TODO: Integrate with a Gutter Annotation Provider
          outputChannel.appendLine(
            ` Annotations retrieved for ${targetUri.fsPath} (${annotations.length} lines). Display mechanism needed.`,
          );
          vscode.window.showInformationMessage(
            `Annotations for ${vscode.workspace.asRelativePath(targetUri)} retrieved (see output channel for now). Gutter display is pending.`,
          );
        } catch (error: any) {
          vscode.window.showErrorMessage(
            `Perforce: Failed to get annotations for ${vscode.workspace.asRelativePath(targetUri)}. ${error.message}`,
          );
          outputChannel.appendLine(
            `  Error annotating ${targetUri.fsPath}: ${error.message}`,
          );
        }
      },
    ),
  );

  // --- Open Resource (Diff) ---
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "perforce.openResource",
      async (
        resourceStateOrUri?: vscode.SourceControlResourceState | vscode.Uri,
      ) => {
        let resourceUri: vscode.Uri | undefined;
        let commandArgs: any[] = []; // Store args passed from SCM view if available

        if (resourceStateOrUri instanceof vscode.Uri) {
          resourceUri = resourceStateOrUri;
        } else if (resourceStateOrUri?.resourceUri) {
          resourceUri = resourceStateOrUri.resourceUri;
          // If called from SCM view, the resource state might have context in its command arguments
          if (resourceStateOrUri.command?.arguments) {
            commandArgs = resourceStateOrUri.command.arguments;
          }
        } else {
          // Try getting from active editor if no argument provided
          resourceUri = vscode.window.activeTextEditor?.document.uri;
          if (!resourceUri) {
            vscode.window.showWarningMessage(
              "No resource selected or active editor found to open/diff.",
            );
            return;
          }
        }

        outputChannel.appendLine(
          `Command 'perforce.openResource' triggered for ${resourceUri.fsPath}`,
        );
        const provider = getProviderForUri(resourceUri);
        if (!provider) {
          vscode.window.showWarningMessage(
            `Could not find Perforce provider for ${vscode.workspace.asRelativePath(resourceUri)}`,
          );
          return;
        }

        try {
          // Pass context from SCM view if available (or empty array)
          await provider.openResource(resourceUri, commandArgs);
        } catch (error: any) {
          vscode.window.showErrorMessage(
            `Perforce: Failed to open resource ${vscode.workspace.asRelativePath(resourceUri)}. ${error.message}`,
          );
          outputChannel.appendLine(
            `  Error opening resource ${resourceUri.fsPath}: ${error.message}`,
          );
        }
      },
    ),
  );

  // --- Resolve ---
  // Basic resolve command - needs more UI for different resolve types
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "perforce.resolve",
      async (resourceState?: vscode.SourceControlResourceState) => {
        if (!resourceState?.resourceUri) {
          vscode.window.showWarningMessage(
            "Select a file requiring resolve in the SCM view.",
          );
          return;
        }
        const resourceUri = resourceState.resourceUri;
        outputChannel.appendLine(
          `Command 'perforce.resolve' triggered for ${resourceUri.fsPath}`,
        );
        const provider = getProviderForUri(resourceUri);
        if (!provider) {
          vscode.window.showWarningMessage(
            `Could not find Perforce provider for ${vscode.workspace.asRelativePath(resourceUri)}`,
          );
          return;
        }

        // TODO: Offer different resolve options (-am, -ay, -at, -as, launch merge tool)
        const resolveType = await vscode.window.showQuickPick(
          [
            {
              label: "-am (Accept Merge)",
              description: "Attempt automatic merge",
              flags: ["-am"],
            },
            {
              label: "-ay (Accept Yours)",
              description: "Discard depot changes",
              flags: ["-ay"],
            },
            {
              label: "-at (Accept Theirs)",
              description: "Discard your changes",
              flags: ["-at"],
            },
            // { label: 'Launch Merge Tool', description: 'Requires configuring P4MERGE' , flags: [] }, // Needs different handling
            {
              label: "-n (Preview)",
              description: "Show what would happen",
              flags: ["-n"],
            },
          ],
          { placeHolder: "Choose resolve type:", ignoreFocusOut: true },
        );

        if (!resolveType) {
          outputChannel.appendLine("Resolve cancelled by user.");
          return;
        }

        try {
          vscode.window.setStatusBarMessage(
            `Perforce: Resolving ${vscode.workspace.asRelativePath(resourceUri)}...`,
            5000,
          );
          // For now, just run the chosen resolve flag on the specific file
          const output = await provider.resolveFile(
            resourceUri,
            resolveType.flags,
          );
          outputChannel.appendLine(
            `Resolve output for ${resourceUri.fsPath}:\n${output}`,
          );
          vscode.window.showInformationMessage(
            `Resolve (${resolveType.label}) attempted for ${vscode.workspace.asRelativePath(resourceUri)}. Check SCM status and output channel.`,
          );
        } catch (error: any) {
          vscode.window.showErrorMessage(
            `Perforce: Failed to resolve ${vscode.workspace.asRelativePath(resourceUri)}. ${error.message}`,
          );
          outputChannel.appendLine(
            `  Error resolving ${resourceUri.fsPath}: ${error.message}`,
          );
        }
      },
    ),
  );

  // --- Changes View ---
  context.subscriptions.push(
    vscode.commands.registerCommand("perforce.viewChanges", async () => {
      outputChannel.appendLine(`Command 'perforce.viewChanges' triggered.`);
      // TODO: Implement a proper Changes Tree View Provider
      // For now, just fetch and display in output channel

      // Find *any* active provider
      const provider =
        scmProviders.size > 0 ? scmProviders.values().next().value : undefined;
      if (!provider) {
        vscode.window.showWarningMessage(
          "No active Perforce workspace found to view changes.",
        );
        return;
      }

      // Example: Get recent 20 submitted changes
      const args = ["-m", "20", "-s", "submitted"];
      // TODO: Add UI to specify filters (user, status, path, max)

      try {
        vscode.window.setStatusBarMessage(
          `Perforce: Fetching recent changes...`,
          3000,
        );
        const changes = await provider.getChanges(args);
        outputChannel.show();
        outputChannel.appendLine(`--- Recent Submitted Changes (Max 20) ---`);
        if (changes.length > 0) {
          changes.forEach((c) => {
            outputChannel.appendLine(
              `${c.change} by ${c.user}@${c.client} on ${new Date(parseInt(c.time, 10) * 1000).toLocaleDateString()}: ${c.desc.substring(0, 80)}${c.desc.length > 80 ? "..." : ""}`,
            );
          });
        } else {
          outputChannel.appendLine(
            "(No submitted changes found with current filters)",
          );
        }
        outputChannel.appendLine(`------------------------------------------`);
        vscode.window.setStatusBarMessage(
          `Perforce: Recent changes shown in output channel.`,
          5000,
        );
      } catch (error: any) {
        vscode.window.showErrorMessage(
          `Perforce: Failed to get changes. ${error.message}`,
        );
        outputChannel.appendLine(`  Error getting changes: ${error.message}`);
      }
    }),
  );

  // --- Jobs View ---
  context.subscriptions.push(
    vscode.commands.registerCommand("perforce.viewJobs", async () => {
      outputChannel.appendLine(`Command 'perforce.viewJobs' triggered.`);
      // TODO: Implement a proper Jobs Tree View Provider
      // For now, just fetch and display in output channel

      // Find *any* active provider
      const provider =
        scmProviders.size > 0 ? scmProviders.values().next().value : undefined;
      if (!provider) {
        vscode.window.showWarningMessage(
          "No active Perforce workspace found to view jobs.",
        );
        return;
      }

      // Example: Get recent 20 open jobs
      const args = ["-m", "20", "-e", "status=open"];
      // TODO: Add UI to specify filters (status, user, etc.)

      try {
        vscode.window.setStatusBarMessage(
          `Perforce: Fetching open jobs...`,
          3000,
        );
        const jobs = await provider.getJobs(args);
        outputChannel.show();
        outputChannel.appendLine(`--- Recent Open Jobs (Max 20) ---`);
        if (jobs.length > 0) {
          jobs.forEach((j) => {
            outputChannel.appendLine(
              `${j.Job} [${j.Status}] reported by ${j.User} on ${j.Date}: ${j.Description}`,
            );
          });
        } else {
          outputChannel.appendLine("(No open jobs found with current filters)");
        }
        outputChannel.appendLine(`--------------------------------`);
        vscode.window.setStatusBarMessage(
          `Perforce: Open jobs shown in output channel.`,
          5000,
        );
      } catch (error: any) {
        vscode.window.showErrorMessage(
          `Perforce: Failed to get jobs. ${error.message}`,
        );
        outputChannel.appendLine(`  Error getting jobs: ${error.message}`);
      }
    }),
  );

  // Command to view a specific job spec
  context.subscriptions.push(
    vscode.commands.registerCommand("perforce.viewJobSpec", async () => {
      const jobId = await vscode.window.showInputBox({
        prompt: "Enter Job ID to view:",
        ignoreFocusOut: true,
      });
      if (!jobId) {
        outputChannel.appendLine("View job spec cancelled.");
        return;
      }

      outputChannel.appendLine(
        `Command 'perforce.viewJobSpec' triggered for ${jobId}`,
      );
      const provider =
        scmProviders.size > 0 ? scmProviders.values().next().value : undefined;
      if (!provider) {
        vscode.window.showWarningMessage(
          "No active Perforce workspace found to view job spec.",
        );
        return;
      }

      try {
        const spec = await provider.getJobSpec(jobId);
        const document = await vscode.workspace.openTextDocument({
          content: spec,
          language: "perforce-spec",
        });
        await vscode.window.showTextDocument(document, { preview: true });
        vscode.window.setStatusBarMessage(
          `Perforce: Opened job spec for ${jobId}.`,
          5000,
        );
      } catch (error: any) {
        vscode.window.showErrorMessage(
          `Perforce: Failed to get job spec for ${jobId}. ${error.message}`,
        );
        outputChannel.appendLine(
          `  Error getting job spec for ${jobId}: ${error.message}`,
        );
      }
    }),
  );

  // --- Placeholders Removed ---
}

// This method is called when your extension is deactivated
export function deactivate() {
  if (outputChannel) {
    outputChannel.appendLine("Deactivating Perforce extension...");
  }
  // Dispose all providers stored in the map
  scmProviders.forEach((provider) => provider.dispose());
  scmProviders.clear();
  // Other resources (like commands, outputChannel, shared perforceService)
  // registered in context.subscriptions will be disposed automatically.
  outputChannel.appendLine("Perforce extension deactivated.");
}

async function updateStatusBarItem(): Promise<void> {
  outputChannel.appendLine("Updating status bar item...");
  // Set default/loading state immediately
  p4StatusBarItem.text = `$(sync~spin) P4: Checking...`;
  p4StatusBarItem.tooltip = "Checking Perforce connection status...";
  p4StatusBarItem.command = "perforce.showOutput"; // Default command

  const activationMode = vscode.workspace
    .getConfiguration("perforce")
    .get<string>("activationMode", "autodetect");
  if (activationMode === "off") {
    p4StatusBarItem.text = `$(circle-slash) P4: Disabled`;
    p4StatusBarItem.tooltip = `Perforce integration is disabled in settings.`;
    p4StatusBarItem.command = undefined; // No command when disabled
    outputChannel.appendLine(`Status bar updated: ${p4StatusBarItem.text}`);
    p4StatusBarItem.show();
    return;
  }

  // Check based on initialized providers
  if (scmProviders.size > 0) {
    const firstProvider = scmProviders.values().next()
      .value as PerforceSCMProvider;
    if (firstProvider) {
      try {
        // Call the new getInfo method
        const info = await firstProvider.getInfo();

        // Successfully retrieved info
        p4StatusBarItem.text = `$(plug) P4: ${info.userName}@${info.clientName}`;
        let tooltipLines = [
          `Perforce Connected`,
          `User: ${info.userName}`,
          `Client: ${info.clientName}`,
        ];
        if (info.clientHost) {
          tooltipLines.push(`Host: ${info.clientHost}`);
        }
        if (info.clientRoot) {
          tooltipLines.push(`Root: ${info.clientRoot}`);
        }
        if (info.serverAddress) {
          tooltipLines.push(`Server: ${info.serverAddress}`);
        }
        if (info.serverVersion) {
          tooltipLines.push(`Version: ${info.serverVersion}`);
        }
        p4StatusBarItem.tooltip = tooltipLines.join("\n");

        // TODO: Define a command to show this info easily?
        p4StatusBarItem.command = "perforce.showOutput"; // Placeholder command
      } catch (error) {
        // Handle errors from getInfo()
        const errorMsg = error instanceof Error ? error.message : String(error);
        outputChannel.appendLine(
          `Error updating status bar via getInfo: ${errorMsg}`,
        );

        if (
          errorMsg.includes("not logged in") ||
          errorMsg.includes("Perforce password (P4PASSWD) invalid or unset")
        ) {
          p4StatusBarItem.text = `$(key) P4: Login Required`;
          p4StatusBarItem.tooltip = `Perforce login required. Click to login.`;
          // Implement 'perforce.login' command
          p4StatusBarItem.command = "perforce.login";
          // p4StatusBarItem.command = 'perforce.showOutput'; // Temporary fallback
        } else if (
          errorMsg.includes("client unknown") ||
          errorMsg.includes("Client specification unknown")
        ) {
          // This might happen if the workspace detection got it wrong initially
          p4StatusBarItem.text = `$(warning) P4: Client Unknown`;
          p4StatusBarItem.tooltip = `Perforce client spec unknown or invalid for this workspace.\nError: ${errorMsg}`;
          p4StatusBarItem.command = "perforce.showOutput";
        } else {
          // Generic error
          p4StatusBarItem.text = `$(error) P4: Error`;
          p4StatusBarItem.tooltip = `Error connecting to Perforce or getting info:\n${errorMsg}`;
          p4StatusBarItem.command = "perforce.showOutput";
        }
      } finally {
        p4StatusBarItem.show(); // Ensure visible after update
      }
    } else {
      // This case should ideally not be reached if scmProviders.size > 0
      p4StatusBarItem.text = `$(warning) P4: Init Error`;
      p4StatusBarItem.tooltip = `Perforce SCM Provider found but not fully initialized?`;
      p4StatusBarItem.command = "perforce.showOutput";
      p4StatusBarItem.show();
    }
  } else {
    // No providers found/initialized
    p4StatusBarItem.text = `$(search) P4: No Client`;
    p4StatusBarItem.tooltip = `No Perforce client workspace detected in open folders.`;
    // TODO: Add command to manually configure/detect?
    p4StatusBarItem.command = "perforce.showOutput";
    p4StatusBarItem.show();
  }
  outputChannel.appendLine(`Status bar updated: ${p4StatusBarItem.text}`);
}

// Function to trigger annotation update (debounced/throttled if needed)
function triggerAnnotationUpdate(editor: vscode.TextEditor) {
  const config = vscode.workspace.getConfiguration(
    "perforce",
    editor.document.uri,
  );
  const enabled = config.get<boolean>("annotations.enabled", true);

  if (!enabled) {
    // Clear decorations if annotations were previously enabled but now disabled
    editor.setDecorations(p4AnnotationDecorationType, []);
    return;
  }

  // Simple flag to prevent multiple concurrent requests for the same editor
  // More sophisticated debouncing could be added here if needed
  if (annotationRequestPending) {
    outputChannel.appendLine(
      "Annotation request already pending, skipping trigger.",
    );
    return;
  }
  annotationRequestPending = true;

  // Run the actual update logic (async)
  updateAnnotationsForEditor(editor).finally(() => {
    annotationRequestPending = false;
  });
}

// Main function to fetch and apply annotations
async function updateAnnotationsForEditor(
  editor: vscode.TextEditor,
): Promise<void> {
  const docUri = editor.document.uri;
  const docUriString = docUri.toString();
  outputChannel.appendLine(`Updating annotations for: ${docUri.fsPath}`);

  // Check configuration again within the async function
  const config = vscode.workspace.getConfiguration("perforce", docUri);
  const enabled = config.get<boolean>("annotations.enabled", true);
  if (!enabled) {
    outputChannel.appendLine(
      " Annotations disabled in config, clearing decorations.",
    );
    editor.setDecorations(p4AnnotationDecorationType, []);
    return;
  }

  // Find the provider for this file
  const provider = getProviderForUri(docUri);
  if (!provider) {
    outputChannel.appendLine(
      " No Perforce provider found for this file, skipping annotations.",
    );
    // Clear any existing decorations from other file types
    editor.setDecorations(p4AnnotationDecorationType, []);
    return;
  }

  // Use cache if available
  if (annotationCache.has(docUriString)) {
    outputChannel.appendLine(" Using cached annotations.");
    const cachedAnnotations = annotationCache.get(docUriString)!;
    applyAnnotations(editor, cachedAnnotations);
    return;
  }

  // Fetch annotations if not cached
  vscode.window.setStatusBarMessage(
    "$(sync~spin) Perforce: Fetching annotations...",
    2000,
  );
  outputChannel.appendLine(" Fetching annotations from Perforce...");
  try {
    // Check if -c flag is needed based on format
    const format = config.get<string>(
      "annotations.format",
      "CL {change} ({user})",
    );
    const useShortFormat = config.get<boolean>(
      "annotations.useShortFormat",
      true,
    );
    const needsUserInfo =
      !useShortFormat &&
      (format.includes("{user}") ||
        format.includes("{date}") ||
        format.includes("{client}"));

    // Pass flag to provider method (TODO: Modify getAnnotations in Provider to accept this)
    // const annotations = await provider.getAnnotations(docUri, needsUserInfo);
    const annotations = await provider.getAnnotations(docUri); // Placeholder: needs update in provider

    annotationCache.set(docUriString, annotations); // Store in cache
    applyAnnotations(editor, annotations);
    vscode.window.setStatusBarMessage("Perforce: Annotations updated.", 3000);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(` Error fetching annotations: ${errorMsg}`);
    // Don't show an error message popup unless debugging, just log it
    // vscode.window.showErrorMessage(`Failed to fetch Perforce annotations: ${errorMsg}`);
    // Clear decorations on error
    editor.setDecorations(p4AnnotationDecorationType, []);
    vscode.window.setStatusBarMessage(
      "$(error) Perforce: Annotation failed",
      3000,
    );
  }
}

// Helper function to apply decorations from fetched annotations
function applyAnnotations(
  editor: vscode.TextEditor,
  annotations: P4Annotation[],
) {
  const config = vscode.workspace.getConfiguration(
    "perforce",
    editor.document.uri,
  );
  const formatString = config.get<string>(
    "annotations.format",
    "CL {change} ({user})",
  );
  const useShortFormat = config.get<boolean>(
    "annotations.useShortFormat",
    true,
  );
  const shortFormat = "{change} {user}"; // Define the short format

  const decorations: vscode.DecorationOptions[] = [];

  if (!annotations || annotations.length === 0) {
    outputChannel.appendLine(" No annotation data received or empty.");
    editor.setDecorations(p4AnnotationDecorationType, []);
    return;
  }

  const maxLine = editor.document.lineCount;
  annotations.forEach((anno) => {
    const lineIndex = anno.line - 1; // P4 is 1-based, VS Code is 0-based
    if (lineIndex >= 0 && lineIndex < maxLine) {
      let contentText = "";
      if (useShortFormat) {
        contentText = shortFormat
          .replace("{change}", anno.change)
          .replace("{user}", anno.user ?? "unknown");
      } else {
        contentText = formatString
          .replace("{change}", anno.change)
          .replace("{user}", anno.user ?? "")
          .replace("{date}", anno.date ?? "")
          .replace("{client}", anno.client ?? "");
      }

      const range = new vscode.Range(lineIndex, 0, lineIndex, 0); // Range for the whole line for decoration purpose
      decorations.push({
        range,
        renderOptions: {
          after: { contentText: ` ${contentText.trim()}` }, // Prepend space for separation
        },
      });
    }
  });

  editor.setDecorations(p4AnnotationDecorationType, decorations);
  outputChannel.appendLine(` Applied ${decorations.length} annotations.`);
}
