import * as vscode from "vscode";
import { P4Options, P4Result } from "./p4Types";
// TODO: Consider moving P4CommandContext to p4Types.ts or a shared utils file
import { P4CommandContext } from "./fileCommands"; // Reuse context from fileCommands

/* Shelves files from a pending changelist. Uses `p4 shelve -c <changelist>`.
 * (Formerly PerforceService.shelve)
 * @param context Object containing execute function and outputChannel.
 * @param changelist The pending changelist number containing files to shelve.
 * @param options P4 options (cwd, P4CLIENT, P4USER etc.).
 * @param args Additional arguments for the shelve command (e.g., ['-r', '-f'] or ['-d']).
 * @returns A promise that resolves on successful shelving or rejects on failure.
 */
export async function p4shelve(
  context: P4CommandContext,
  changelist: string,
  options: P4Options = {},
  args: string[] = [],
): Promise<void> {
  if (!changelist || changelist === "default") {
    // 'default' might be disallowed by server for shelve
    throw new Error(
      "A specific pending changelist number must be provided for p4 shelve.",
    );
  }
  const effectiveArgs = ["-c", changelist, ...args];
  const commandDesc = `p4 shelve ${effectiveArgs.join(" ")}`;
  context.outputChannel.appendLine(`Executing \`${commandDesc}\`...`);

  try {
    // Shelve output can indicate success, warnings, or errors
    const result = await context.execute("shelve", effectiveArgs, options);

    // Check stdout/stderr for success/failure indicators
    if (result.stderr) {
      context.outputChannel.appendLine(
        `\`${commandDesc}\` stderr:\n${result.stderr.trim()}`,
      );
      // Check for common issues like "already contains shelved files" (needs -r?), "no files to shelve"
      if (result.stderr.includes("no files to shelve")) {
        context.outputChannel.appendLine(
          "Shelve: No files to shelve in the changelist.",
        );
        // Treat as success? Or inform caller?
        return;
      }
      // Other stderr might indicate real errors.
    }
    if (result.stdout) {
      context.outputChannel.appendLine(
        `\`${commandDesc}\` stdout:\n${result.stdout.trim()}`,
      );
      // Success messages often include "Change X shelved."
      const match = result.stdout.match(/Change\s+(\d+)\s+shelved/);
      if (match) {
        context.outputChannel.appendLine(
          `Successfully shelved changelist ${match[1]}.`,
        );
        return;
      }
    }

    // If we reached here without returning or throwing, check if an error should have been thrown
    // based on lack of success messages.
    context.outputChannel.appendLine(
      "Shelve command finished, but could not confirm success from output.",
    );
    // Consider throwing if success message is expected? For now, assume execute() catches actual failures.
  } catch (error: any) {
    context.outputChannel.appendLine(
      `Error executing \`${commandDesc}\`: ${error.message}`,
    );
    // Errors could be "must resolve", "changelist unknown", permissions, etc.
    throw error;
  }
}

/**
 * Unshelves files from a shelved changelist into the workspace. Uses `p4 unshelve -s <shelvedChange> [-c <targetChange>]`.
 * (Formerly PerforceService.unshelve)
 * @param context Object containing execute function and outputChannel.
 * @param shelvedChange The changelist number where the files were shelved.
 * @param targetChange Optional: The target pending changelist number to unshelve into. Defaults to the default changelist.
 * @param options P4 options (cwd, P4CLIENT, P4USER etc.). Use -n for preview, -f for force.
 * @param args Additional arguments for the unshelve command (e.g., ['-f', '-n']).
 * @returns A promise that resolves on successful unshelving or rejects on failure.
 */
export async function p4unshelve(
  context: P4CommandContext,
  shelvedChange: string,
  targetChange?: string,
  options: P4Options = {},
  args: string[] = [],
): Promise<void> {
  if (!shelvedChange) {
    throw new Error(
      "Shelved changelist number must be provided for p4 unshelve.",
    );
  }
  const effectiveArgs = ["-s", shelvedChange];
  if (targetChange) {
    effectiveArgs.push("-c", targetChange);
  }
  effectiveArgs.push(...args); // Append any extra flags like -f, -n

  const commandDesc = `p4 unshelve ${effectiveArgs.join(" ")}`;
  context.outputChannel.appendLine(`Executing \`${commandDesc}\`...`);

  try {
    // Unshelve output indicates files being unshelved, potential conflicts, etc.
    const result = await context.execute("unshelve", effectiveArgs, options);

    // Check stdout/stderr for success/failure/conflict indicators
    if (result.stderr) {
      context.outputChannel.appendLine(
        `\`${commandDesc}\` stderr:\n${result.stderr.trim()}`,
      );
      // Check for common issues: "must resolve", "no such shelved change", "file(s) not found in shelve"
      if (result.stderr.includes("must resolve")) {
        context.outputChannel.appendLine(
          "Unshelve requires resolve. Files likely opened for integrate.",
        );
        // This often isn't a fatal error, the files are opened but need merging.
        // Caller needs to handle the resolve step.
        // Return successfully but maybe indicate resolve needed? Or let caller infer from state?
        return;
      }
      if (result.stderr.includes("no such shelved change")) {
        throw new Error(`Shelved changelist '${shelvedChange}' not found.`);
      }
      // Other errors might be permissions, etc.
    }
    if (result.stdout) {
      context.outputChannel.appendLine(
        `\`${commandDesc}\` stdout:\n${result.stdout.trim()}`,
      );
      // Look for success messages like "received" or "opened for integrate"
    }

    // Assuming if no error was thrown, and 'must resolve' wasn't the only output, it succeeded.
    context.outputChannel.appendLine(
      `\`${commandDesc}\` executed. Check output/status for results (resolve may be needed).`,
    );
  } catch (error: any) {
    context.outputChannel.appendLine(
      `Error executing \`${commandDesc}\`: ${error.message}`,
    );
    // Errors could include target changelist issues, file locking, etc.
    throw error;
  }
}
