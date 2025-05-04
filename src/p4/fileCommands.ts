import * as vscode from "vscode";
import {
  P4Options,
  P4Result,
  P4OpenedFile,
  P4StatusFile,
  P4CommandContext,
  P4DescribeResult,
} from "./p4Types";

// Re-export the context type so other command modules can use it
export type { P4CommandContext };

/**
 * Uses `p4 where` to find the local filesystem path for a given depot or client path.
 * (Formerly PerforceService.getLocalPath)
 * @param context Object containing execute function and outputChannel.
 * @param depotOrClientPath The depot or client path (e.g., //depot/main/file.c or //clientname/main/file.c)
 * @param options P4 options (especially cwd might be relevant)
 * @returns The absolute local filesystem path, or null if not found/mapped.
 */
export async function p4where(
  context: P4CommandContext,
  depotOrClientPath: string,
  options: P4Options = {},
): Promise<string | null> {
  if (!depotOrClientPath) {
    return null;
  }
  context.outputChannel.appendLine(
    `Executing \`p4 where ${depotOrClientPath}\`...`,
  );
  try {
    // Execute 'p4 where' - no -G needed
    const result = await context.execute(
      "where",
      [depotOrClientPath],
      options,
      false,
    );

    if (result.stderr) {
      // 'p4 where' often reports errors like 'not in client view' to stderr
      context.outputChannel.appendLine(
        `\`p4 where ${depotOrClientPath}\` reported error: ${result.stderr.trim()}`,
      );
      if (
        result.stderr.includes("not in client view") ||
        result.stderr.includes("no such file(s)")
      ) {
        return null; // Path is not mapped locally
      }
      // Log other unexpected stderr, but might still have stdout?
    }

    if (result.stdout) {
      const lines = result.stdout.trim().split(/\r?\n/);
      // Output format: <depot> <client> <local>
      // There might be multiple lines if the input maps to multiple locations (e.g. stream overlay)
      // We need to find the line that corresponds most closely to the input path, or often just the first line?
      // Let's assume the first line is usually the primary mapping.

      for (const line of lines) {
        const parts = line.trim().split(" ");
        if (parts.length >= 3) {
          // Check if depot or client path in the output matches our input
          const depotPath = parts[0];
          const clientPath = parts[1];
          const localPath = parts.slice(2).join(" "); // Join remaining parts for paths with spaces

          // Basic check: does the output depot/client path match input?
          // This is simplistic - might need better matching for complex mappings
          if (
            depotPath === depotOrClientPath ||
            clientPath === depotOrClientPath
          ) {
            context.outputChannel.appendLine(
              `  \`p4 where\` mapped "${depotOrClientPath}" to local path: "${localPath}"`,
            );
            // Basic validation: does it look like a plausible path?
            if (
              localPath &&
              localPath !== "/dev/null" &&
              !localPath.startsWith("-")
            ) {
              // Exclude common non-paths
              return localPath;
            }
          }
        }
      }
      // If loop finishes without returning, no matching line found
      context.outputChannel.appendLine(
        `  \`p4 where ${depotOrClientPath}\` output did not contain a matching mapping line.`,
      );
      return null;
    }

    // No stdout and no specific stderr error? Unlikely but possible.
    context.outputChannel.appendLine(
      `  \`p4 where ${depotOrClientPath}\` produced no usable output.`,
    );
    return null;
  } catch (error: any) {
    // Handle errors from execute() itself (e.g., p4 command not found)
    context.outputChannel.appendLine(
      `Error executing \`p4 where ${depotOrClientPath}\`: ${error.message}`,
    );
    console.error(`Error executing p4 where for ${depotOrClientPath}`, error);
    return null;
  }
}

/**
 * Retrieves the list of files opened in the current workspace. Uses `p4 opened -G`.
 * (Formerly PerforceService.getOpenedFiles)
 * @param context Object containing execute function and outputChannel.
 * @param options P4 options (especially cwd, P4CLIENT).
 * @returns A promise that resolves to an array of P4OpenedFile objects.
 */
export async function p4opened(
  context: P4CommandContext,
  options: P4Options = {},
): Promise<P4OpenedFile[]> {
  context.outputChannel.appendLine("Executing `p4 opened -G`...");
  try {
    const result = await context.execute("opened", [], options, true);

    if (
      result.stderr &&
      !result.stderr.includes("File(s) not opened on this client")
    ) {
      // Log unexpected stderr, but proceed if we got parsed output
      context.outputChannel.appendLine(
        `Warning during \`p4 opened -G\`: ${result.stderr}`,
      );
    }

    // Ensure parsedOutput is an array before trying to map it
    if (Array.isArray(result.parsedOutput)) {
      // Map the parsed objects to our P4OpenedFile interface
      // Need to be careful about field names matching the marshal output
      const openedFiles: P4OpenedFile[] = result.parsedOutput.map(
        (item: any) => ({
          depotFile: item.depotFile, // Assuming these field names from marshal
          clientFile: item.clientFile,
          rev: item.rev,
          haveRev: item.haveRev,
          action: item.action,
          change: item.change,
          type: item.type,
          user: item.user,
          client: item.client,
          // Add explicit null checks or defaults if fields might be missing
        }),
      );
      context.outputChannel.appendLine(
        `\`p4 opened -G\` found ${openedFiles.length} files.`,
      );
      return openedFiles;
    } else if (
      result.stderr &&
      result.stderr.includes("File(s) not opened on this client")
    ) {
      // This is not an error, just means no files are open
      context.outputChannel.appendLine(
        "`p4 opened -G`: No files opened on this client.",
      );
      return [];
    } else {
      // Handle cases where parsing might have failed or output was unexpected
      context.outputChannel.appendLine(
        "`p4 opened -G\` did not return a valid array in parsedOutput.",
      );
      return [];
    }
  } catch (error: any) {
    context.outputChannel.appendLine(
      `Error executing \`p4 opened -G\`: ${error.message}`,
    );
    console.error("Error executing p4 opened", error);
    return [];
  }
}

/**
 * Retrieves the status of files in the workspace compared to the depot. Uses `p4 status -G`.
 * (Formerly PerforceService.getStatus)
 * @param context Object containing execute function and outputChannel.
 * @param options P4 options (cwd, P4CLIENT, etc.).
 * @returns A promise that resolves to an array of P4StatusFile objects.
 */
export async function p4status(
  context: P4CommandContext,
  options: P4Options = {},
): Promise<P4StatusFile[]> {
  context.outputChannel.appendLine("Executing `p4 status -G`...");
  try {
    // p4 status might need specific paths, but defaults to cwd if not specified
    const result = await context.execute("status", [], options, true);

    if (result.stderr) {
      // Log stderr but potentially continue if there is parsed data
      context.outputChannel.appendLine(
        `Warning/Info during \`p4 status -G\`: ${result.stderr}`,
      );
    }

    if (Array.isArray(result.parsedOutput)) {
      const statusFiles: P4StatusFile[] = result.parsedOutput.map(
        (item: any) => ({
          depotFile: item.depotFile,
          clientFile: item.clientFile, // Should always be present for status
          status: item.status ?? item.action, // Status field name might be 'status' or 'action'
          change: item.change,
          type: item.type,
          ourLock: item.ourLock === "yes", // Check actual marshal representation
          otherLock: item.otherLock ? [item.otherLock] : undefined, // Might be a single string or list? Adjust as needed
        }),
      );
      context.outputChannel.appendLine(
        `\`p4 status -G\` reported status for ${statusFiles.length} files.`,
      );
      return statusFiles;
    } else {
      // p4 status with -G returns an empty list if nothing matches,
      // so an empty array is a valid successful result.
      context.outputChannel.appendLine(
        "`p4 status -G`: No file statuses reported (or output was not an array).",
      );
      return [];
    }
  } catch (error: any) {
    context.outputChannel.appendLine(
      `Error executing \`p4 status -G\`: ${error.message}`,
    );
    console.error("Error executing p4 status", error);
    // Decide if throwing or returning empty array is better
    // Returning empty array might be safer for SCM provider
    return [];
  }
}

/**
 * Opens a file for add. Uses `p4 add <filePath>`.
 * (Formerly PerforceService.add)
 * @param context Object containing execute function and outputChannel.
 * @param filePath The absolute local path of the file to add.
 * @param options P4 options (cwd, P4CLIENT, changelist etc.).
 * @returns A promise that resolves on success, rejects on failure.
 */
export async function p4add(
  context: P4CommandContext,
  filePath: string,
  options: P4Options = {},
): Promise<void> {
  if (!filePath) {
    throw new Error("File path must be provided for p4 add.");
  }
  context.outputChannel.appendLine(`Executing \`p4 add ${filePath}\`...`);
  try {
    // Specify the file path as an argument
    // No tagged output needed for basic add
    const result = await context.execute("add", [filePath], options, false);

    // Check stderr for potential warnings even if command succeeds
    if (result.stderr) {
      context.outputChannel.appendLine(
        `Warning/Info during \`p4 add ${filePath}\`: ${result.stderr}`,
      );
      // Check for common non-error messages if needed
      if (result.stderr.includes("currently opened for add")) {
        // This might not be considered an error by the caller
        context.outputChannel.appendLine("File was already opened for add.");
        return; // Or handle as success? Decide based on desired behavior
      }
    }
    context.outputChannel.appendLine(
      `\`p4 add ${filePath}\` executed successfully.`,
    );
  } catch (error: any) {
    // execute() already logs the error
    context.outputChannel.appendLine(
      `Error executing \`p4 add ${filePath}\`: ${error.message}`,
    );
    // Rethrow the error to indicate failure
    throw error;
  }
}

/**
 * Opens a file for edit. Uses `p4 edit <filePath>`.
 * (Formerly PerforceService.edit)
 * @param context Object containing execute function and outputChannel.
 * @param filePath The absolute local path of the file to edit.
 * @param options P4 options (cwd, P4CLIENT, changelist, filetype etc.).
 * @returns A promise that resolves on success, rejects on failure.
 */
export async function p4edit(
  context: P4CommandContext,
  filePath: string,
  options: P4Options = {},
): Promise<void> {
  if (!filePath) {
    throw new Error("File path must be provided for p4 edit.");
  }
  context.outputChannel.appendLine(`Executing \`p4 edit ${filePath}\`...`);
  try {
    // Specify the file path as an argument
    // No tagged output needed for basic edit
    const result = await context.execute("edit", [filePath], options, false);

    // Check stderr for potential warnings even if command succeeds
    if (result.stderr) {
      context.outputChannel.appendLine(
        `Warning/Info during \`p4 edit ${filePath}\`: ${result.stderr}`,
      );
      // Check for common non-error messages
      if (
        result.stderr.includes("already opened for edit") ||
        result.stderr.includes("can't edit exclusive file")
      ) {
        // These might not be fatal errors depending on context
        context.outputChannel.appendLine(
          "File was already opened or is exclusive.",
        );
        // Decide if we should return or throw based on requirements
        return;
      }
    }
    context.outputChannel.appendLine(
      `\`p4 edit ${filePath}\` executed successfully.`,
    );
  } catch (error: any) {
    // execute() already logs the error
    context.outputChannel.appendLine(
      `Error executing \`p4 edit ${filePath}\`: ${error.message}`,
    );
    // Rethrow the error to indicate failure
    throw error;
  }
}

/**
 * Opens a file for delete. Uses `p4 delete <filePath>`.
 * (Formerly PerforceService.delete)
 * @param context Object containing execute function and outputChannel.
 * @param filePath The absolute local path of the file to delete.
 * @param options P4 options (cwd, P4CLIENT, changelist etc.).
 * @returns A promise that resolves on success, rejects on failure.
 */
export async function p4delete(
  context: P4CommandContext,
  filePath: string,
  options: P4Options = {},
): Promise<void> {
  if (!filePath) {
    throw new Error("File path must be provided for p4 delete.");
  }
  context.outputChannel.appendLine(`Executing \`p4 delete ${filePath}\`...`);
  try {
    // Specify the file path as an argument
    // No tagged output needed for basic delete
    const result = await context.execute("delete", [filePath], options, false);

    // Check stderr for potential warnings
    if (result.stderr) {
      context.outputChannel.appendLine(
        `Warning/Info during \`p4 delete ${filePath}\`: ${result.stderr}`,
      );
      if (result.stderr.includes("already opened for delete")) {
        context.outputChannel.appendLine("File was already opened for delete.");
        return; // Treat as success
      }
    }
    context.outputChannel.appendLine(
      `\`p4 delete ${filePath}\` executed successfully.`,
    );
  } catch (error: any) {
    context.outputChannel.appendLine(
      `Error executing \`p4 delete ${filePath}\`: ${error.message}`,
    );
    // Handle specific errors? e.g., file not on client, file not synced.
    // Rethrow for now.
    throw error;
  }
}

/**
 * Reverts an opened file to its previous state. Uses `p4 revert <filePath>`.
 * (Formerly PerforceService.revert)
 * @param context Object containing execute function and outputChannel.
 * @param filePath The absolute local path of the file to revert.
 * @param options P4 options (cwd, P4CLIENT, changelist etc.). Use -n for preview.
 * @returns A promise that resolves on success, rejects on failure.
 */
export async function p4revert(
  context: P4CommandContext,
  filePath: string,
  options: P4Options = {},
): Promise<void> {
  if (!filePath) {
    throw new Error("File path must be provided for p4 revert.");
  }
  context.outputChannel.appendLine(`Executing \`p4 revert ${filePath}\`...`);
  try {
    // Specify the file path as an argument
    // Use -k? -c? Check revert options if more control is needed.
    // No tagged output needed for basic revert
    const result = await context.execute("revert", [filePath], options, false);

    // Check stderr for non-error info
    if (result.stderr) {
      context.outputChannel.appendLine(
        `Info during \`p4 revert ${filePath}\`: ${result.stderr}`,
      );
      // Check for 'file(s) not opened on this client' - this is success in revert context
      if (result.stderr.includes("not opened on this client")) {
        context.outputChannel.appendLine(
          "File was not opened, revert had no effect.",
        );
        return; // Treat as success
      }
    }
    // Stdout often confirms the revert, e.g., "//depot/path#rev - was edit, reverted"
    if (result.stdout) {
      context.outputChannel.appendLine(
        `\`p4 revert ${filePath}\` output: ${result.stdout.trim()}`,
      );
    }
    context.outputChannel.appendLine(
      `\`p4 revert ${filePath}\` executed successfully (or file was not open).`,
    );
  } catch (error: any) {
    context.outputChannel.appendLine(
      `Error executing \`p4 revert ${filePath}\`: ${error.message}`,
    );
    // If revert fails because the file needs reconcile, the caller might need to handle this.
    throw error;
  }
}

/**
 * Syncs workspace files to the depot. Uses `p4 sync [filePaths...]`.
 * (Formerly PerforceService.sync)
 * @param context Object containing execute function and outputChannel.
 * @param filePaths Optional array of absolute local paths or depot paths to sync. Syncs the entire client if empty or not provided.
 * @param options P4 options (cwd, P4CLIENT, etc.). Use -n for preview, -f for force.
 * @returns A promise that resolves on success, rejects on failure.
 */
export async function p4sync(
  context: P4CommandContext,
  filePaths: string[] = [],
  options: P4Options = {},
): Promise<void> {
  const target = filePaths.length > 0 ? filePaths.join(" ") : "..."; // Use '...' to sync all if no paths given
  context.outputChannel.appendLine(`Executing \`p4 sync ${target}\`...`);
  try {
    // Pass file paths as arguments if provided
    // Tagged output (-G) is available for sync but complex; skipping for now
    const result = await context.execute("sync", filePaths, options, false);

    // Sync output can be verbose. Log stdout and stderr.
    if (result.stdout) {
      context.outputChannel.appendLine(
        `\`p4 sync ${target}\` stdout:\n${result.stdout.trim()}`,
      );
    }
    if (result.stderr) {
      // Stderr might contain 'up-to-date' messages which aren't errors
      context.outputChannel.appendLine(
        `\`p4 sync ${target}\` stderr:\n${result.stderr.trim()}`,
      );
      if (result.stderr.includes("file(s) up-to-date")) {
        // This is a common success case
      } else {
        // Log other stderr as potential warnings/info
      }
    }

    // Basic success check: command didn't throw
    context.outputChannel.appendLine(`\`p4 sync ${target}\` executed.`);
  } catch (error: any) {
    context.outputChannel.appendLine(
      `Error executing \`p4 sync ${target}\`: ${error.message}`,
    );
    // Handle specific errors? e.g., "must revert before syncing"
    throw error;
  }
}

/**
 * Moves/renames a file. Uses `p4 move <fromFile> <toFile>`.
 * (Formerly PerforceService.move)
 * @param context Object containing execute function and outputChannel.
 * @param fromFilePath The absolute local path of the source file.
 * @param toFilePath The absolute local path of the target file.
 * @param options P4 options (cwd, P4CLIENT, changelist etc.).
 * @returns A promise that resolves on success, rejects on failure.
 */
export async function p4move(
  context: P4CommandContext,
  fromFilePath: string,
  toFilePath: string,
  options: P4Options = {},
): Promise<void> {
  if (!fromFilePath || !toFilePath) {
    throw new Error(
      "Both source and target file paths must be provided for p4 move.",
    );
  }
  context.outputChannel.appendLine(
    `Executing \`p4 move ${fromFilePath} ${toFilePath}\`...`,
  );
  try {
    // Specify from and to paths as arguments
    // No tagged output available/needed for move
    const result = await context.execute(
      "move",
      [fromFilePath, toFilePath],
      options,
      false,
    );

    // Check stderr for info/warnings
    if (result.stderr) {
      context.outputChannel.appendLine(
        `Warning/Info during \`p4 move\`: ${result.stderr}`,
      );
      // Add checks for specific non-error stderr messages if needed
    }
    // Stdout usually confirms the move, e.g., "//depot/toFile#1 - moved from //depot/fromFile#1"
    if (result.stdout) {
      context.outputChannel.appendLine(
        `\`p4 move\` output: ${result.stdout.trim()}`,
      );
    }
    context.outputChannel.appendLine(
      `\`p4 move ${fromFilePath} -> ${toFilePath}\` executed successfully.`,
    );
  } catch (error: any) {
    context.outputChannel.appendLine(
      `Error executing \`p4 move ${fromFilePath} ${toFilePath}\`: ${error.message}`,
    );
    // Handle specific errors? e.g., target exists, source not synced/opened.
    throw error;
  }
}

/**
 * Gets the text specification for a new changelist. Uses `p4 change -o`.
 * (Formerly PerforceService.newChangeSpec)
 * @param context Object containing execute function and outputChannel.
 * @param options P4 options (cwd, P4CLIENT, P4USER etc.).
 * @returns A promise that resolves to the raw changelist specification string.
 */
export async function p4newChangeSpec(
  context: P4CommandContext,
  options: P4Options = {},
): Promise<string> {
  context.outputChannel.appendLine("Executing `p4 change -o`...");
  try {
    // -o outputs the spec to stdout
    // No tagged output
    const result = await context.execute("change", ["-o"], options, false);

    if (result.stderr) {
      // Log stderr as warning/info, but stdout should still have the spec
      context.outputChannel.appendLine(
        `Info during \`p4 change -o\`: ${result.stderr}`,
      );
    }

    if (!result.stdout) {
      // This should not happen on success
      throw new Error("p4 change -o did not return a spec to stdout.");
    }

    context.outputChannel.appendLine(
      "Successfully retrieved new changelist spec.",
    );
    return result.stdout;
  } catch (error: any) {
    context.outputChannel.appendLine(
      `Error executing \`p4 change -o\`: ${error.message}`,
    );
    throw error;
  }
}

/**
 * Gets the text specification for an existing changelist. Uses `p4 change -o <changelist>`.
 * (Formerly PerforceService.editChangeSpec)
 * @param context Object containing execute function and outputChannel.
 * @param changelist The changelist number (e.g., '12345') or 'default'/'new'.
 * @param options P4 options (cwd, P4CLIENT, P4USER etc.).
 * @returns A promise that resolves to the raw changelist specification string.
 */
export async function p4editChangeSpec(
  context: P4CommandContext,
  changelist: string,
  options: P4Options = {},
): Promise<string> {
  if (!changelist) {
    throw new Error("Changelist number/ID must be provided to fetch its spec.");
  }
  context.outputChannel.appendLine(
    `Executing \`p4 change -o ${changelist}\`...`,
  );
  try {
    // -o outputs the spec to stdout
    const result = await context.execute(
      "change",
      ["-o", changelist],
      options,
      false,
    );

    if (result.stderr) {
      context.outputChannel.appendLine(
        `Info during \`p4 change -o ${changelist}\`: ${result.stderr}`,
      );
      // Check for specific errors like "Change X unknown."
      if (result.stderr.includes("unknown")) {
        throw new Error(`Changelist '${changelist}' not found or invalid.`);
      }
    }

    if (!result.stdout) {
      throw new Error(
        `p4 change -o ${changelist} did not return a spec to stdout.`,
      );
    }

    context.outputChannel.appendLine(
      `Successfully retrieved spec for changelist ${changelist}.`,
    );
    return result.stdout;
  } catch (error: any) {
    // Handle cases where execute throws directly (e.g., invalid changelist number)
    // or if we re-throw based on stderr
    context.outputChannel.appendLine(
      `Error executing \`p4 change -o ${changelist}\`: ${error.message}`,
    );
    throw error;
  }
}

/**
 * Saves a changelist specification (creates a new one or updates an existing one). Uses `p4 change -i`.
 * (Formerly PerforceService.saveChangeSpec)
 * @param context Object containing execute function and outputChannel.
 * @param specString The complete changelist specification text.
 * @param options P4 options (cwd, P4CLIENT, P4USER etc.).
 * @returns A promise that resolves to the changelist number (as a string) that was created/updated.
 * @throws Error if saving fails or the changelist number cannot be determined.
 */
export async function p4saveChangeSpec(
  context: P4CommandContext,
  specString: string,
  options: P4Options = {},
): Promise<string> {
  if (!specString) {
    throw new Error(
      "Changelist specification string must be provided to save.",
    );
  }
  context.outputChannel.appendLine("Executing `p4 change -i`...");
  try {
    // Pass the spec string as standard input
    const result = await context.execute(
      "change",
      ["-i"],
      options,
      false,
      specString,
    );

    // Successful save typically outputs "Change X created." or "Change X updated." to stdout.
    // Stderr might contain warnings or info, e.g., about file validation.
    if (result.stderr) {
      context.outputChannel.appendLine(
        `Info/Warning during \`p4 change -i\`: ${result.stderr}`,
      );
      // Check for specific errors in stderr that might indicate failure despite exit code 0?
    }

    if (result.stdout) {
      context.outputChannel.appendLine(
        `\`p4 change -i\` stdout: ${result.stdout.trim()}`,
      );
      // Attempt to parse the changelist number from stdout
      const match = result.stdout.match(/Change\s+(\d+)\s+(created|updated)/);
      if (match && match[1]) {
        const changeNumber = match[1];
        context.outputChannel.appendLine(
          `Successfully saved changelist ${changeNumber}.`,
        );
        return changeNumber;
      } else {
        // Output didn't match expected format, but command succeeded.
        // This might happen with certain server configurations or versions.
        // Log a warning but consider it a success if no error was thrown.
        context.outputChannel.appendLine(
          "Could not parse changelist number from success message, but command succeeded.",
        );
        // Returning a generic success indicator or throwing might be options
        // Let's return 'unknown' for now, caller needs to be aware.
        return "unknown"; // Or throw? Decide based on how critical the number is.
      }
    } else {
      // If stdout is empty but no error was thrown, it's an unexpected state.
      throw new Error("p4 change -i succeeded but produced no output.");
    }
  } catch (error: any) {
    // execute() already logs the error details
    context.outputChannel.appendLine(
      `Error executing \`p4 change -i\`: ${error.message}`,
    );
    // Common errors include spec validation errors, locking issues.
    throw error; // Rethrow to indicate failure
  }
}

/**
 * Submits an existing pending changelist or the default changelist. Uses `p4 submit [-c <changelist>]`.
 * (Formerly PerforceService.submit)
 * @param context Object containing execute function and outputChannel.
 * @param changelist Optional: The changelist number to submit. If omitted, submits the default changelist.
 * @param options P4 options (cwd, P4CLIENT, P4USER etc.).
 * @returns A promise that resolves with information about the submission (e.g., submitted change number) or rejects on failure.
 */
export async function p4submit(
  context: P4CommandContext,
  changelist?: string,
  options: P4Options = {},
): Promise<{
  submittedChange?: string;
  success?: boolean;
  message?: string;
} | null> {
  const args = changelist ? ["-c", changelist] : [];
  const commandDesc = changelist ? `p4 submit -c ${changelist}` : "p4 submit";
  context.outputChannel.appendLine(`Executing \`${commandDesc}\`...`);

  try {
    // Submit doesn't typically use tagged output, but output can be complex (locking, triggers, errors)
    const result = await context.execute("submit", args, options, false);

    // Submit output varies greatly depending on success, failure, triggers, etc.
    // Successful submit usually indicates submitted change number in stderr/stdout.
    // e.g., stderr: "Submitting change 12345." stdout: "Locking N files ...", "edit //path#rev", "Change 12345 submitted."

    if (result.stderr) {
      context.outputChannel.appendLine(
        `\`${commandDesc}\` stderr:\n${result.stderr.trim()}`,
      );
      // Check for common non-error messages like 'No files to submit' or 'must resolve first'
      if (result.stderr.includes("No files to submit")) {
        context.outputChannel.appendLine(
          "Submit: No files to submit in the specified changelist.",
        );
        // Consider this success or a specific status? Returning null for now.
        return null;
      }
      if (result.stderr.includes("must resolve")) {
        context.outputChannel.appendLine(
          "Submit failed: Files must be resolved first.",
        );
        // Throw a specific error?
        throw new Error(
          "Submit failed: Files must be resolved first. Details in output channel.",
        );
      }
    }
    if (result.stdout) {
      context.outputChannel.appendLine(
        `\`${commandDesc}\` stdout:\n${result.stdout.trim()}`,
      );
    }

    // Attempt to parse submitted change number (often appears in stdout *and* stderr)
    const output = result.stdout + "\n" + result.stderr; // Combine both for searching
    const match = output.match(/Change\s+(\d+)\s+submitted/);
    if (match && match[1]) {
      const submittedChange = match[1];
      context.outputChannel.appendLine(
        `Successfully submitted changelist ${submittedChange}.`,
      );
      return { submittedChange }; // Return structured info
    } else {
      // Command succeeded but couldn't parse the number? Less likely for submit.
      context.outputChannel.appendLine(
        "Submit command finished, but couldn't parse submitted changelist number.",
      );
      // Consider this a success? Or throw?
      return {
        success: true,
        message: "Could not parse submitted change number.",
      };
    }
  } catch (error: any) {
    // execute() logs the raw error
    context.outputChannel.appendLine(
      `Error executing \`${commandDesc}\`: ${error.message}`,
    );
    // Submit can fail for many reasons: files locked, triggers, validation, connection issues.
    // Rethrow the error
    throw error;
  }
}

/**
 * Describes a pending or submitted changelist. Uses `p4 describe -G <changelist>`.
 * (Formerly PerforceService.describe)
 * @param context Object containing execute function and outputChannel.
 * @param changelist The changelist number to describe.
 * @param options P4 options (cwd, P4CLIENT, P4USER etc.).
 * @returns A promise that resolves to the parsed tagged output object representing the changelist details.
 */
export async function p4describe(
  context: P4CommandContext,
  changelist: string,
  options: P4Options = {},
): Promise<P4DescribeResult | null> {
  if (!changelist) {
    throw new Error("Changelist number must be provided for p4 describe.");
  }
  const commandDesc = `p4 describe -G ${changelist}`;
  context.outputChannel.appendLine(`Executing \`${commandDesc}\`...`);

  try {
    // Use tagged output (-G) for easier parsing
    const result = await context.execute(
      "describe",
      [changelist],
      options,
      true,
    );

    if (result.stderr) {
      context.outputChannel.appendLine(
        `Warning/Info during \`${commandDesc}\`: ${result.stderr}`,
      );
      // Check for "Change X unknown" or similar errors
      if (
        result.stderr.includes("unknown") ||
        result.stderr.includes("no such changelist")
      ) {
        throw new Error(
          `Describe failed: Changelist '${changelist}' not found.`,
        );
      }
    }

    // The parsedOutput should contain the structured changelist data
    if (result.parsedOutput) {
      // p4 describe -G usually returns a single object (or a list with one object)
      const descriptionData = Array.isArray(result.parsedOutput)
        ? result.parsedOutput[0]
        : result.parsedOutput;
      context.outputChannel.appendLine(
        `Successfully described changelist ${changelist}.`,
      );
      // Basic type casting, consider adding runtime validation if structure varies significantly
      return descriptionData as P4DescribeResult;
    } else {
      // Should not happen if command succeeded and stderr didn't indicate failure
      throw new Error(
        `p4 describe -G ${changelist} succeeded but produced no parsed output.`,
      );
    }
  } catch (error: any) {
    context.outputChannel.appendLine(
      `Error executing \`${commandDesc}\`: ${error.message}`,
    );
    // Errors could be permissions, invalid number format, etc.
    throw error;
  }
}

/**
 * Performs a diff between two Perforce file revisions. Uses `p4 diff2 [flags] <file1>[rev] <file2>[rev]`.
 * This is often more useful than `p4 diff` for comparing specific revisions (depot, have, shelved).
 * @param context Object containing execute function and outputChannel.
 * @param file1 Path and revision specifier for the first file (e.g., //depot/path#have, //depot/path@=change, file.txt).
 * @param file2 Path and revision specifier for the second file (e.g., //depot/path#head, //depot/path@shelvedChange, file.txt).
 * @param options P4 options (cwd, P4CLIENT, etc.).
 * @param diffFlags Optional array of flags for the diff command (e.g., ['-u'] for unified diff, ['-dw'] to ignore whitespace).
 * @returns A promise that resolves to the raw diff output string.
 * @throws Error if diff command fails.
 */
export async function p4diff2(
  context: P4CommandContext,
  file1: string,
  file2: string,
  options: P4Options = {},
  diffFlags: string[] = [],
): Promise<string> {
  if (!file1 || !file2) {
    throw new Error("Two file specifiers must be provided for p4 diff2.");
  }
  const args = [...diffFlags, file1, file2];
  const commandDesc = `p4 diff2 ${args.join(" ")}`;
  context.outputChannel.appendLine(`Executing \`${commandDesc}\`...`);

  try {
    // Diff output is typically consumed raw, so no -G
    const result = await context.execute("diff2", args, options, false);

    // Diff commands often report differences via exit codes but also stdout/stderr.
    // 'no differences' might be reported to stderr but is not an error.
    if (result.stderr && !result.stderr.includes("no differences")) {
      context.outputChannel.appendLine(
        `Warning/Info during \`${commandDesc}\`: ${result.stderr}`,
      );
      // Check for common errors like "file not found"
      if (
        result.stderr.includes("no such file") ||
        result.stderr.includes("not in client view")
      ) {
        throw new Error(
          `Diff failed: One or both files not found or not mapped (${file1}, ${file2}).`,
        );
      }
    }

    context.outputChannel.appendLine(`\`${commandDesc}\` completed.`);
    // Return stdout which contains the actual diff text
    return result.stdout ?? ""; // Return empty string if stdout is null/undefined
  } catch (error: any) {
    // execute might throw if diff returns non-zero exit code for differences,
    // depending on how reckless-node-perforce handles it.
    // We might need to catch specific exit codes if differences are reported as errors.
    // For now, assume non-zero exit code indicates a real error.
    context.outputChannel.appendLine(
      `Error executing \`${commandDesc}\`: ${error.message}`,
    );
    throw error;
  }
}

/**
 * Runs the Perforce resolve process for specified files.
 * This can be used to preview resolves, accept server/client versions, or launch the merge tool.
 * Uses `p4 resolve [flags] [filePaths...]`.
 * @param context Object containing execute function and outputChannel.
 * @param filePaths Optional array of file paths to resolve. Resolves all if empty.
 * @param options P4 options (cwd, P4CLIENT, etc.).
 * @param resolveFlags Flags controlling the resolve type (e.g., ['-n'] for preview, ['-am'] accept merge, ['-ay'] accept yours, ['-at'] accept theirs).
 * @returns A promise resolving to the raw stdout/stderr output, indicating resolve status or merge tool interaction.
 * @throws Error on failure.
 */
export async function p4resolve(
  context: P4CommandContext,
  resolveFlags: string[],
  filePaths: string[] = [],
  options: P4Options = {},
): Promise<string> {
  if (!resolveFlags || resolveFlags.length === 0) {
    throw new Error(
      "Resolve flags (e.g., -n, -am, -ay) must be provided for p4 resolve.",
    );
  }
  const args = [...resolveFlags, ...filePaths];
  const commandDesc = `p4 resolve ${args.join(" ")}`;
  context.outputChannel.appendLine(`Executing \`${commandDesc}\`...`);

  try {
    // Resolve has no tagged output
    // Output needs careful parsing to understand what happened (merged, yours, theirs, skipped, needs merge tool)
    const result = await context.execute("resolve", args, options, false);

    // Both stdout and stderr can contain important information for resolve
    const output = `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
    context.outputChannel.appendLine(`\`${commandDesc}\` output:\n${output}`);

    // Check for common non-error messages in stderr
    if (result.stderr && result.stderr.includes("no file(s) to resolve")) {
      context.outputChannel.appendLine("Resolve: No files needed resolving.");
      return output; // Still return output for logging
    }

    // Resolve often exits 0 even if further action (merge tool) is needed.
    // The output indicates the status.
    context.outputChannel.appendLine(
      `\`${commandDesc}\` completed. Check output for details.`,
    );
    return output;
  } catch (error: any) {
    context.outputChannel.appendLine(
      `Error executing \`${commandDesc}\`: ${error.message}`,
    );
    // Errors could be file locking, invalid flags, etc.
    throw error;
  }
}
