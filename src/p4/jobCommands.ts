import * as vscode from "vscode";
import { P4Options, P4Result, P4JobSummary } from "./p4Types";
// TODO: Define P4CommandContext centrally
import { P4CommandContext } from "./fileCommands";

/**
 * Marks a job as fixed by a specific changelist. Uses `p4 fix -c <changelist> <jobId>`.
 * Can also be used to un-fix a job with `p4 fix -d -c <changelist> <jobId>`.
 * (Formerly PerforceService.fixJob)
 * @param context Object containing execute function and outputChannel.
 * @param changelist The changelist number that fixes the job.
 * @param jobId The ID of the job being fixed.
 * @param options P4 options (cwd, P4CLIENT, P4USER etc.).
 * @param deleteFix If true, uses the -d flag to remove the fix association.
 * @returns A promise that resolves on success, rejects on failure.
 */
export async function p4fixJob(
  context: P4CommandContext,
  changelist: string,
  jobId: string,
  options: P4Options = {},
  deleteFix: boolean = false,
): Promise<void> {
  if (!changelist || !jobId) {
    throw new Error(
      "Changelist number and Job ID must be provided for p4 fix.",
    );
  }
  const args = ["-c", changelist];
  if (deleteFix) {
    args.push("-d");
  }
  args.push(jobId);

  const commandDesc = `p4 fix ${args.join(" ")}`;
  context.outputChannel.appendLine(`Executing \`${commandDesc}\`...`);

  try {
    // No tagged output for fix
    const result = await context.execute("fix", args, options);

    // Check output - success message is usually "Job <jobId> fixed by change <changelist>"
    // or "Job <jobId> un-fixed for change <changelist>"
    // Stderr might contain "Job <jobId> already fixed" or "Job <jobId> not fixed"

    let successMessageFound = false;
    if (result.stdout) {
      context.outputChannel.appendLine(
        `\`${commandDesc}\` stdout: ${result.stdout.trim()}`,
      );
      if (
        result.stdout.includes("fixed by change") ||
        result.stdout.includes("un-fixed for change")
      ) {
        successMessageFound = true;
      }
    }
    if (result.stderr) {
      context.outputChannel.appendLine(
        `\`${commandDesc}\` stderr: ${result.stderr.trim()}`,
      );
      // Check for known non-error conditions
      if (
        result.stderr.includes("already fixed") ||
        result.stderr.includes("not fixed")
      ) {
        context.outputChannel.appendLine(
          "Job fix status was already as requested.",
        );
        return; // Treat as success
      }
      if (
        result.stderr.includes("no such job") ||
        result.stderr.includes("no such changelist")
      ) {
        throw new Error(
          `Fix failed: Job '${jobId}' or Changelist '${changelist}' not found.`,
        );
      }
    }

    if (
      !successMessageFound &&
      !(
        result.stderr.includes("already fixed") ||
        result.stderr.includes("not fixed")
      )
    ) {
      // If no clear success or known non-error message, and no error thrown, it's ambiguous.
      context.outputChannel.appendLine(
        "Fix command finished, but success confirmation not found in output.",
      );
      // Decide whether to throw or assume success based on execute() not throwing.
      // Let's assume success for now unless execute throws.
    }
    context.outputChannel.appendLine(`\`${commandDesc}\` executed.`);
  } catch (error: any) {
    context.outputChannel.appendLine(
      `Error executing \`${commandDesc}\`: ${error.message}`,
    );
    throw error;
  }
}

/**
 * Retrieves the specification for a single job. Uses `p4 job -o <jobId>`.
 * @param context Object containing execute function and outputChannel.
 * @param jobId The ID of the job to retrieve.
 * @param options P4 options (cwd, P4CLIENT, P4USER etc.).
 * @returns A promise that resolves to the raw job specification string.
 */
export async function p4job(
  context: P4CommandContext,
  jobId: string,
  options: P4Options = {},
): Promise<string> {
  if (!jobId) {
    throw new Error("Job ID must be provided for p4 job.");
  }
  const args = ["-o", jobId];
  const commandDesc = `p4 job ${args.join(" ")}`;
  context.outputChannel.appendLine(`Executing \`${commandDesc}\`...`);

  try {
    // Job spec is output raw, no -G
    const result = await context.execute("job", args, options);

    if (result.stderr) {
      context.outputChannel.appendLine(
        `Warning/Info during \`${commandDesc}\`: ${result.stderr}`,
      );
      if (result.stderr.includes("No such job")) {
        throw new Error(`Job '${jobId}' not found.`);
      }
    }

    if (!result.stdout) {
      throw new Error(`p4 job -o ${jobId} did not return a spec to stdout.`);
    }

    context.outputChannel.appendLine(
      `Successfully retrieved spec for job ${jobId}.`,
    );
    return result.stdout;
  } catch (error: any) {
    context.outputChannel.appendLine(
      `Error executing \`${commandDesc}\`: ${error.message}`,
    );
    throw error;
  }
}

/**
 * Retrieves a list of jobs, optionally filtered. Uses `p4 jobs -G [flags]`.
 * @param context Object containing execute function and outputChannel.
 * @param options P4 options (cwd, P4CLIENT, P4USER etc.).
 * @param args Additional arguments/flags for filtering (e.g., ['-m', '10'], ['-e', 'jobstatus=open user=name'], ['//depot/path/...']).
 * @returns A promise that resolves to an array of P4JobSummary objects.
 */
export async function p4jobs(
  context: P4CommandContext,
  options: P4Options = {},
  args: string[] = [],
): Promise<P4JobSummary[]> {
  const effectiveArgs = [...args];
  const commandDesc = `p4 jobs ${effectiveArgs.join(" ")}`;
  context.outputChannel.appendLine(`Executing \`${commandDesc}\`...`);

  try {
    const result = await context.execute("jobs", effectiveArgs, options);

    if (result.stderr) {
      context.outputChannel.appendLine(
        `Warning/Info during \`${commandDesc}\`: ${result.stderr}`,
      );
      // Check for common non-errors like "No jobs found."
      if (result.stderr.includes("No jobs found")) {
        context.outputChannel.appendLine(
          "Jobs command reported no jobs found.",
        );
        return [];
      }
    }

    // p4 jobs output is an array of objects
    if (Array.isArray(result.parsedOutput)) {
      // Map the parsed objects to our P4JobSummary interface
      // Field names often start with uppercase - confirm from marshal output
      const jobs: P4JobSummary[] = result.parsedOutput.map((item: any) => ({
        Job: item.Job, // Assuming uppercase based on typical p4 job output
        Status: item.Status,
        User: item.User,
        Date: item.Date, // YYYY/MM/DD
        Description: item.Description, // Truncated description
      }));
      context.outputChannel.appendLine(
        `Successfully parsed ${jobs.length} job summaries.`,
      );
      return jobs;
    } else {
      // Valid result might be an empty array if no jobs match
      context.outputChannel.appendLine(
        "Jobs command did not return a valid array in parsedOutput (or no jobs matched).",
      );
      return [];
    }
  } catch (error: any) {
    context.outputChannel.appendLine(
      `Error executing \`${commandDesc}\`: ${error.message}`,
    );
    throw error;
  }
}
