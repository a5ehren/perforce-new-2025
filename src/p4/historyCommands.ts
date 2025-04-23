import * as vscode from 'vscode';
import { P4Options, P4Result, P4Annotation, P4FilelogEntry } from './p4Types';
// TODO: Define P4CommandContext centrally
import { P4CommandContext } from './fileCommands';

/**
 * Retrieves per-line annotation data (blame) for a file. Uses `p4 annotate -c -q <filePath>`.
 * (Formerly PerforceService.annotate)
 * @param context Object containing execute function and outputChannel.
 * @param filePath The absolute local or depot path of the file to annotate.
 * @param options P4 options (cwd, P4CLIENT, P4USER etc.).
 * @returns A promise that resolves to an array of P4Annotation objects.
 */
export async function p4annotate(context: P4CommandContext, filePath: string, options: P4Options = {}): Promise<P4Annotation[]> {
    if (!filePath) {
        throw new Error('File path must be provided for p4 annotate.');
    }
    // Using -c for detailed attribution (user@client date) and -q to suppress file content
    const args = ['-c', '-q', filePath];
    const commandDesc = `p4 annotate ${args.join(' ')}`;
    context.outputChannel.appendLine(`Executing \`${commandDesc}\`...`);

    try {
        // Annotate does not support -G
        const result = await context.execute('annotate', args, options, false);

        if (result.stderr) {
            // Annotate might report errors like "no such file"
            context.outputChannel.appendLine(`Warning/Info during \`${commandDesc}\`: ${result.stderr}`);
            if (result.stderr.includes('no such file') || result.stderr.includes('not in client view')) {
                 throw new Error(`Annotate failed: File '${filePath}' not found or not in client view.`);
            }
            // Log other stderr but proceed if stdout exists
        }

        const annotations: P4Annotation[] = [];
        if (result.stdout) {
            const lines = result.stdout.trim().split(/\r?\n/);
            let currentLineNumber = 1; // Perforce annotate output is 1-based implicitly

            for (const line of lines) {
                // Expect format: CHANGE: rest OR CHANGE <user@client date>: rest
                // With -q, the ': rest' part should be minimal or empty
                // Regex handles optional <user@client date> part
                const match = line.match(/^(\d+)(?:\s+<([^@]+)@([^> ]+)\s+([^>]+)>)?/);

                if (match) {
                    annotations.push({
                        line: currentLineNumber,
                        change: match[1],
                        user: match[2],   // May be undefined
                        client: match[3], // May be undefined
                        date: match[4]    // May be undefined
                    });
                } else {
                    // Handle simple case: "CHANGE:" (less likely with -c but possible)
                    const simpleMatch = line.match(/^(\d+):/);
                     if (simpleMatch) {
                          annotations.push({
                               line: currentLineNumber,
                               change: simpleMatch[1]
                          });
                     } else {
                          // Log unexpected line format
                          context.outputChannel.appendLine(`Skipping unparsable annotate line: ${line}`);
                     }
                }
                currentLineNumber++;
            }
             context.outputChannel.appendLine(`Successfully parsed ${annotations.length} annotation lines for ${filePath}.`);
        }
        return annotations;

    } catch (error: any) {
        context.outputChannel.appendLine(`Error executing \`${commandDesc}\`: ${error.message}`);
        throw error;
    }
}

/**
 * Retrieves the revision history (filelog) for a file. Uses `p4 filelog -G <filePath>`.
 * (Formerly PerforceService.filelog)
 * @param context Object containing execute function and outputChannel.
 * @param filePath The absolute local or depot path of the file.
 * @param options P4 options (cwd, P4CLIENT, P4USER etc.). Can include flags like -m for max revisions.
 * @param args Additional arguments like ['-m', '10']
 * @returns A promise that resolves to an array of P4FilelogEntry objects, ordered newest to oldest.
 */
export async function p4filelog(context: P4CommandContext, filePath: string, options: P4Options = {}, args: string[] = []): Promise<P4FilelogEntry[]> {
    if (!filePath) {
        throw new Error('File path must be provided for p4 filelog.');
    }
    const effectiveArgs = [...args, filePath];
    // Ensure -G is always used for parsing, add it if not present in custom args
    if (!effectiveArgs.includes('-G')) {
        effectiveArgs.unshift('-G');
    }
    const commandDesc = `p4 filelog ${effectiveArgs.join(' ')}`;
    context.outputChannel.appendLine(`Executing \`${commandDesc}\`...`);

    try {
        // Use tagged output (-G)
        // Remove filePath from args array as it's passed separately to execute
        const cmdArgs = effectiveArgs.filter(arg => arg !== filePath);
        const result = await context.execute('filelog', cmdArgs, options, true); // Pass true for useTaggedOutput

        if (result.stderr) {
            context.outputChannel.appendLine(`Warning/Info during \`${commandDesc}\`: ${result.stderr}`);
            if (result.stderr.includes('no such file')) {
                throw new Error(`Filelog failed: File '${filePath}' not found.`);
            }
        }

        // Filelog -G output is typically an array of objects, one per file path queried.
        // Each object contains a 'rev' key holding an array of revision details.
        if (Array.isArray(result.parsedOutput)) {
             let revisions: any[] = [];
             // Find the object for the requested filePath (in case wildcards were used, though unlikely here)
             // And extract its 'rev' array. Often it's just the first element.
             if (result.parsedOutput.length > 0 && Array.isArray(result.parsedOutput[0].rev)) {
                revisions = result.parsedOutput[0].rev;
             } else {
                context.outputChannel.appendLine('Could not find expected revisions array in filelog output.');
                return [];
             }

            const filelogEntries: P4FilelogEntry[] = revisions.map((item: any) => ({
                rev: item.rev,
                change: item.change,
                action: item.action,
                date: item.date, // This is typically epoch time as a string
                user: item.user,
                client: item.client,
                desc: item.desc,
                type: item.type
                // Map integration details here if using -i flag and 'how' field exists
            }));
            context.outputChannel.appendLine(`Successfully parsed ${filelogEntries.length} filelog entries for ${filePath}.`);
            return filelogEntries;
        } else {
             context.outputChannel.appendLine('Filelog command did not return a valid array in parsedOutput.');
             return [];
        }

    } catch (error: any) {
        context.outputChannel.appendLine(`Error executing \`${commandDesc}\`: ${error.message}`);
        throw error;
    }
} 