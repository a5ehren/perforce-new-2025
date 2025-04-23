import * as vscode from 'vscode';
import { P4Options, P4Result, P4DescribeResult, P4CommandContext, P4ChangeSummary } from './p4Types'; // Import relevant types

/**
 * Gets the text specification for a new changelist. Uses `p4 change -o`.
 * (Formerly PerforceService.newChangeSpec)
 * @param context Object containing execute function and outputChannel.
 * @param options P4 options (cwd, P4CLIENT, P4USER etc.).
 * @returns A promise that resolves to the raw changelist specification string.
 */
export async function p4newChangeSpec(context: P4CommandContext, options: P4Options = {}): Promise<string> {
    context.outputChannel.appendLine('Executing `p4 change -o`...');
    try {
        // -o outputs the spec to stdout
        // No tagged output
        const result = await context.execute('change', ['-o'], options, false);

        if (result.stderr) {
             // Log stderr as warning/info, but stdout should still have the spec
             context.outputChannel.appendLine(`Info during \`p4 change -o\`: ${result.stderr}`);
        }

        if (!result.stdout) {
            // This should not happen on success
            throw new Error('p4 change -o did not return a spec to stdout.');
        }

        context.outputChannel.appendLine('Successfully retrieved new changelist spec.');
        return result.stdout;

    } catch (error: any) {
        context.outputChannel.appendLine(`Error executing \`p4 change -o\`: ${error.message}`);
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
export async function p4editChangeSpec(context: P4CommandContext, changelist: string, options: P4Options = {}): Promise<string> {
    if (!changelist) {
        throw new Error('Changelist number/ID must be provided to fetch its spec.');
    }
    context.outputChannel.appendLine(`Executing \`p4 change -o ${changelist}\`...`);
    try {
        // -o outputs the spec to stdout
        const result = await context.execute('change', ['-o', changelist], options, false);

        if (result.stderr) {
             context.outputChannel.appendLine(`Info during \`p4 change -o ${changelist}\`: ${result.stderr}`);
             // Check for specific errors like "Change X unknown."
             if (result.stderr.includes('unknown')) {
                 throw new Error(`Changelist '${changelist}' not found or invalid.`);
             }
        }

        if (!result.stdout) {
            throw new Error(`p4 change -o ${changelist} did not return a spec to stdout.`);
        }

        context.outputChannel.appendLine(`Successfully retrieved spec for changelist ${changelist}.`);
        return result.stdout;

    } catch (error: any) {
        // Handle cases where execute throws directly (e.g., invalid changelist number)
        // or if we re-throw based on stderr
        context.outputChannel.appendLine(`Error executing \`p4 change -o ${changelist}\`: ${error.message}`);
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
export async function p4saveChangeSpec(context: P4CommandContext, specString: string, options: P4Options = {}): Promise<string> {
    if (!specString) {
        throw new Error('Changelist specification string must be provided to save.');
    }
    context.outputChannel.appendLine('Executing `p4 change -i`...');
    try {
        // Pass the spec string as standard input
        const result = await context.execute('change', ['-i'], options, false, specString);

        // Successful save typically outputs "Change X created." or "Change X updated." to stdout.
        // Stderr might contain warnings or info, e.g., about file validation.
        if (result.stderr) {
            context.outputChannel.appendLine(`Info/Warning during \`p4 change -i\`: ${result.stderr}`);
            // Check for specific errors in stderr that might indicate failure despite exit code 0?
        }

        if (result.stdout) {
            context.outputChannel.appendLine(`\`p4 change -i\` stdout: ${result.stdout.trim()}`);
            // Attempt to parse the changelist number from stdout
            const match = result.stdout.match(/Change\s+(\d+)\s+(created|updated)/);
            if (match && match[1]) {
                const changeNumber = match[1];
                context.outputChannel.appendLine(`Successfully saved changelist ${changeNumber}.`);
                return changeNumber;
            } else {
                // Output didn't match expected format, but command succeeded.
                // This might happen with certain server configurations or versions.
                // Log a warning but consider it a success if no error was thrown.
                context.outputChannel.appendLine('Could not parse changelist number from success message, but command succeeded.');
                // Returning a generic success indicator or throwing might be options
                // Let's return 'unknown' for now, caller needs to be aware.
                return 'unknown'; // Or throw? Decide based on how critical the number is.
            }
        } else {
            // If stdout is empty but no error was thrown, it's an unexpected state.
            throw new Error('p4 change -i succeeded but produced no output.');
        }

    } catch (error: any) {
        // execute() already logs the error details
        context.outputChannel.appendLine(`Error executing \`p4 change -i\`: ${error.message}`);
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
export async function p4submit(context: P4CommandContext, changelist?: string, options: P4Options = {}): Promise<{ submittedChange?: string; success?: boolean; message?: string } | null> {
    const args = changelist ? ['-c', changelist] : [];
    const commandDesc = changelist ? `p4 submit -c ${changelist}` : 'p4 submit';
    context.outputChannel.appendLine(`Executing \`${commandDesc}\`...`);

    try {
        // Submit doesn't typically use tagged output, but output can be complex (locking, triggers, errors)
        const result = await context.execute('submit', args, options, false);

        // Submit output varies greatly depending on success, failure, triggers, etc.
        // Successful submit usually indicates submitted change number in stderr/stdout.
        // e.g., stderr: "Submitting change 12345." stdout: "Locking N files ...", "edit //path#rev", "Change 12345 submitted."

        if (result.stderr) {
            context.outputChannel.appendLine(`\`${commandDesc}\` stderr:\n${result.stderr.trim()}`);
            // Check for common non-error messages like 'No files to submit' or 'must resolve first'
            if (result.stderr.includes('No files to submit')) {
                context.outputChannel.appendLine('Submit: No files to submit in the specified changelist.');
                // Consider this success or a specific status? Returning null for now.
                return null;
            }
            if (result.stderr.includes('must resolve')) {
                context.outputChannel.appendLine('Submit failed: Files must be resolved first.');
                // Throw a specific error?
                throw new Error('Submit failed: Files must be resolved first. Details in output channel.');
            }
        }
        if (result.stdout) {
            context.outputChannel.appendLine(`\`${commandDesc}\` stdout:\n${result.stdout.trim()}`);
        }

        // Attempt to parse submitted change number (often appears in stdout *and* stderr)
        const output = result.stdout + '\n' + result.stderr; // Combine both for searching
        const match = output.match(/Change\s+(\d+)\s+submitted/);
        if (match && match[1]) {
            const submittedChange = match[1];
            context.outputChannel.appendLine(`Successfully submitted changelist ${submittedChange}.`);
            return { submittedChange }; // Return structured info
        } else {
             // Command succeeded but couldn't parse the number? Less likely for submit.
             context.outputChannel.appendLine("Submit command finished, but couldn't parse submitted changelist number.");
             // Consider this a success? Or throw?
             return { success: true, message: 'Could not parse submitted change number.' };
        }

    } catch (error: any) {
        // execute() logs the raw error
        context.outputChannel.appendLine(`Error executing \`${commandDesc}\`: ${error.message}`);
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
export async function p4describe(context: P4CommandContext, changelist: string, options: P4Options = {}): Promise<P4DescribeResult | null> {
    if (!changelist) {
        throw new Error('Changelist number must be provided for p4 describe.');
    }
    const commandDesc = `p4 describe -G ${changelist}`;
    context.outputChannel.appendLine(`Executing \`${commandDesc}\`...`);

    try {
        // Use tagged output (-G) for easier parsing
        const result = await context.execute('describe', [changelist], options, true);

        if (result.stderr) {
            context.outputChannel.appendLine(`Warning/Info during \`${commandDesc}\`: ${result.stderr}`);
            // Check for "Change X unknown" or similar errors
            if (result.stderr.includes('unknown') || result.stderr.includes('no such changelist')) {
                throw new Error(`Describe failed: Changelist '${changelist}' not found.`);
            }
        }

        // The parsedOutput should contain the structured changelist data
        if (result.parsedOutput) {
            // p4 describe -G usually returns a single object (or a list with one object)
            const descriptionData = Array.isArray(result.parsedOutput) ? result.parsedOutput[0] : result.parsedOutput;
             context.outputChannel.appendLine(`Successfully described changelist ${changelist}.`);
             // Basic type casting, consider adding runtime validation if structure varies significantly
             return descriptionData as P4DescribeResult;
        } else {
            // Should not happen if command succeeded and stderr didn't indicate failure
            throw new Error(`p4 describe -G ${changelist} succeeded but produced no parsed output.`);
        }

    } catch (error: any) {
        context.outputChannel.appendLine(`Error executing \`${commandDesc}\`: ${error.message}`);
        // Errors could be permissions, invalid number format, etc.
        throw error;
    }
}

/**
 * Retrieves a list of submitted or pending changelists. Uses `p4 changes [flags]`.
 * @param context Object containing execute function and outputChannel.
 * @param options P4 options (cwd, P4CLIENT, P4USER etc.).
 * @param args Additional arguments/flags for filtering (e.g., ['-s', 'pending'], ['-m', '10'], ['-u', 'user'], ['//depot/path/...']).
 * @returns A promise that resolves to an array of P4ChangeSummary objects.
 */
export async function p4changes(context: P4CommandContext, options: P4Options = {}, args: string[] = []): Promise<P4ChangeSummary[]> {
    // Ensure -G is always used for parsing, add it if not present in custom args
    const effectiveArgs = [...args];
    if (!effectiveArgs.includes('-G')) {
        effectiveArgs.unshift('-G');
    }
    const commandDesc = `p4 changes ${effectiveArgs.join(' ')}`;
    context.outputChannel.appendLine(`Executing \`${commandDesc}\`...`);

    try {
        // Use tagged output (-G)
        const result = await context.execute('changes', effectiveArgs, options, true);

        if (result.stderr) {
            context.outputChannel.appendLine(`Warning/Info during \`${commandDesc}\`: ${result.stderr}`);
            // Check for common errors like invalid flags or paths
            const noSuchFileError = 'no such file'; // Define string separately
            if (result.stderr.includes(noSuchFileError)) { // Check against variable
                context.outputChannel.appendLine(` Changes command reported '${noSuchFileError}', likely due to path filter.`);
                 // Return empty array as no changes match the path
                 return [];
            }
             // Other stderr might indicate permission issues, etc.
        }

        // p4 changes -G output is an array of objects
        if (Array.isArray(result.parsedOutput)) {
            // Map the parsed objects to our P4ChangeSummary interface
            // Need to confirm field names from actual marshal output
            const changes: P4ChangeSummary[] = result.parsedOutput.map((item: any) => ({
                change: item.change,
                time: item.time, // Epoch time string
                user: item.user,
                client: item.client,
                status: item.status, // pending, submitted, shelved
                changeType: item.changeType, // public, restricted
                path: item.path, // Optional path associated with change (often first file)
                desc: item.desc // Description
            }));
            context.outputChannel.appendLine(`Successfully parsed ${changes.length} changelist summaries.`);
            return changes;
        } else {
            // Valid result might be an empty array if no changes match
            context.outputChannel.appendLine('Changes command did not return a valid array in parsedOutput (or no changes matched).');
            return [];
        }

    } catch (error: any) {
        context.outputChannel.appendLine(`Error executing \`${commandDesc}\`: ${error.message}`);
        // Consider returning empty array vs throwing? Depends on expected usage.
        // Throwing indicates a problem with the command itself.
        throw error; 
    }
} 