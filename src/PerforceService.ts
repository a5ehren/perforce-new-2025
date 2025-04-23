import * as vscode from 'vscode';
import p4 from 'reckless-node-perforce'; // Assuming default import
const marshal = require('py-marshal'); // Import the parser library
// import { P4Executable } from 'reckless-node-perforce/dist/p4executable'; // Need to check actual path/types

// Import necessary types from the new file
import { P4Options, P4Result } from './p4/p4Types';
// Import the specific command and context we need
import { p4where, P4CommandContext } from './p4/fileCommands';

// REMOVE Interfaces that conflict with ./p4/p4Types
/*
export interface P4Options {
    cwd?: string;
    P4CLIENT?: string;
    P4USER?: string;
    P4PORT?: string;
    P4PASSWD?: string;
    P4CHARSET?: string;
    P4CONFIG?: string; // Path to P4CONFIG file
    p4Path?: string;   // Path to p4 executable
    // Add other relevant P4 environment variables if needed
}
*/

/*
export interface P4Result {
    stdout: string;
    stderr: string;
    // Potentially add parsed data later (e.g., parsed JSON from -G)
    parsedOutput?: any; 
}
*/

// REMOVE other local interfaces likely defined in p4Types or specific command files
/*
export interface P4OpenedFile {
    depotFile: string;
    clientFile?: string; // May not always be present?
    rev?: string;       // Revision opened (# or head)
    haveRev?: string;    // Revision on workspace
    action: string;     // e.g., edit, add, delete, integrate
    change: string;     // 'default' or changelist number
    type: string;       // Perforce file type (e.g., text, binary)
    user?: string;      // User who opened the file
    client?: string;    // Workspace where file is opened
    // Add other potentially useful fields if they appear in -G output
}
*/

/*
export interface P4StatusFile {
    depotFile?: string; // May not be present for adds not submitted
    clientFile: string;
    status: string; // Action like 'add', 'edit', 'delete', 'branch', 'integrate'
    change?: string; // Changelist number or 'default'
    type?: string;   // File type
    ourLock?: boolean; // If the current client has the file locked
    otherLock?: string[]; // List of users/clients holding locks
    // add other relevant fields from p4 status -G
}
*/

/*
export interface P4Annotation {
    line: number;
    change: string; // Changelist number
    user?: string;   // Optional: from -c flag
    client?: string; // Optional: from -c flag
    date?: string;   // Optional: from -c flag
}
*/

/*
export interface P4FilelogEntry {
    rev: string;
    change: string;
    action: string;
    date: string; // Typically epoch time
    user: string;
    client: string;
    desc: string; // Description of the change
    type: string; // File type
    // Potentially add integration history if needed (using -i flag)
}
*/

export class PerforceService implements vscode.Disposable {
    private outputChannel: vscode.OutputChannel;
    private p4PathSetting: string | undefined; // Path to p4 executable from config
    private debugMode: boolean = false; // From config

    constructor(outputChannel: vscode.OutputChannel) {
        this.outputChannel = outputChannel;
        this.updateConfiguration();

        // Watch for configuration changes
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('perforce')) {
                this.updateConfiguration();
            }
        });
    }

    private updateConfiguration(): void {
        const config = vscode.workspace.getConfiguration('perforce');
        const commandPath = config.get<string>('command');
        this.p4PathSetting = (commandPath && commandPath !== 'none') ? commandPath : undefined;
        this.debugMode = config.get<boolean>('debugP4Commands', false);
        this.outputChannel.appendLine(`PerforceService config updated: p4Path=${this.p4PathSetting}, debug=${this.debugMode}`);
    }

    /**
     * Executes a raw p4 command.
     * @param command The p4 command (e.g., 'edit', 'info').
     * @param args Array of arguments for the command.
     * @param options P4 environment options (P4USER, P4CLIENT, etc.) and cwd.
     * @param useTaggedOutput If true, attempts to use '-G' for tagged output.
     * @param input Standard input to pass to the p4 command (e.g., for 'p4 change -i').
     */
    public async execute(command: string, args: string[] = [], options: P4Options = {}, useTaggedOutput = false, input?: string): Promise<P4Result> {
        this.logCommand(command, args, options, input);

        const effectiveArgs = [...args];
        let requiresPythonParsing = false;

        if (useTaggedOutput) {
            // p4 -G marshals output as Python objects. We'll need to parse this.
            effectiveArgs.unshift('-G');
            requiresPythonParsing = true;
        }

        // Combine specific options with defaults, ensuring no undefined values are passed if the library doesn't handle them
        const commandOptions: any = {
            cwd: options.cwd,
            p4Path: options.p4Path ?? this.p4PathSetting, // Allow per-call override, else use config
            P4CLIENT: options.P4CLIENT,
            P4USER: options.P4USER,
            P4PORT: options.P4PORT,
            P4PASSWD: options.P4PASSWD,
            P4CHARSET: options.P4CHARSET,
            P4CONFIG: options.P4CONFIG,
            // Add stdin handling if the library supports it
            // stdin: input
        };

        // Clean up undefined properties as reckless-node-perforce might pass them to spawn
        Object.keys(commandOptions).forEach(key => commandOptions[key] === undefined && delete commandOptions[key]);

        try {
            // Assume reckless-node-perforce main export is the function call
            // Need to verify if it accepts stdin
            // NOTE: reckless-node-perforce needs to return stdout as a Buffer for marshal parsing
            // If it returns a string, encoding issues might occur. Let's assume it can return a Buffer
            // or that the string conversion is lossless for the relevant byte range.
            const result = await p4(command, effectiveArgs, commandOptions);

            const stdout = result.stdout ?? ''; // Assuming string for now
            const stderr = result.stderr ?? '';
            this.logOutput(stdout, stderr);

            const p4Result: P4Result = { stdout, stderr };

            if (requiresPythonParsing && stdout) {
                try {
                    // Call the new parsing method
                    p4Result.parsedOutput = this.parseTaggedOutput(stdout);
                    if (this.debugMode) {
                        this.outputChannel.appendLine(`Parsed Tagged Output (${command}): ${JSON.stringify(p4Result.parsedOutput, null, 2).substring(0, 1000)}...`);
                    }
                } catch (parseError: any) {
                    this.outputChannel.appendLine(`Error parsing tagged output for command '${command}': ${parseError.message}`);
                    console.error("Tagged output parse error:", parseError);
                    // Keep raw stdout, but log the error. Caller can decide how to handle.
                    // Alternatively, could re-throw or add an error flag to P4Result.
                }
            }

            return p4Result;

        } catch (error: any) {
            // reckless-node-perforce rejects on non-zero exit code or spawn errors
            const stderr = error?.stderr ?? (error instanceof Error ? error.message : String(error));
            this.logError(command, args, stderr);
            // Re-throw a structured error? Or let the caller handle it?
            throw new Error(`P4 command '${command}' failed: ${stderr}`);
        }
    }

    /**
     * Checks if the user is currently logged in to Perforce.
     * Uses `p4 login -s`.
     */
    public async checkLoginStatus(options: P4Options = {}): Promise<boolean> {
        try {
            // login -s should exit with 0 if logged in, non-zero if not/error
            // It might print different messages to stdout/stderr depending on state.
            await this.execute('login', ['-s'], options);
            // If execute doesn't throw, the exit code was 0, meaning logged in.
            this.outputChannel.appendLine('Login status check: User is logged in.');
            return true;
        } catch (error: any) {
            // Handle specific error indicating "not logged in" vs other errors
            const errorMessage = error instanceof Error ? error.message : String(error);
            if (errorMessage.includes('Perforce password (P4PASSWD) invalid or unset') ||
                errorMessage.includes('Your session has expired') ||
                errorMessage.includes('User not logged in'))
            {
                this.outputChannel.appendLine('Login status check: User is not logged in.');
                return false;
            } else {
                // It might be a different error (e.g., cannot connect)
                this.outputChannel.appendLine(`Login status check failed with unexpected error: ${errorMessage}`);
                // Re-throw unexpected errors
                throw error;
            }
        }
    }

    /**
     * Attempts to log the user into Perforce.
     * @param password Optional password to pipe to stdin.
     */
    public async login(options: P4Options = {}, password?: string): Promise<void> {
        this.outputChannel.appendLine('Attempting p4 login...');
        try {
            // Execute p4 login. If a password is provided, pass it as stdin.
            // Note: relies on reckless-node-perforce and p4 handling stdin correctly.
            const result = await this.execute('login', [], options, false, password);
            if (result.stderr && !result.stderr.includes('User logged in')) {
                 // Handle cases where login command succeeds (exit 0) but might show warnings
                 this.outputChannel.appendLine(`Login attempt stderr: ${result.stderr}`);
            }
            if (result.stdout.includes('User logged in')) {
                this.outputChannel.appendLine('Login successful.');
            } else {
                 // Might need more specific checks based on p4 output
                 this.outputChannel.appendLine('Login command finished, but success message not found in stdout.');
            }
        } catch (error) {
            // Error is already logged by execute method
            this.outputChannel.appendLine('Login attempt failed.');
            // Rethrow to signal failure to the caller
            throw error;
        }
    }

    /**
     * Logs the user out from Perforce.
     */
    public async logout(options: P4Options = {}): Promise<void> {
        this.outputChannel.appendLine('Attempting p4 logout...');
        try {
            await this.execute('logout', [], options);
            this.outputChannel.appendLine('Logout successful.');
        } catch (error) {
            // Error is already logged by execute method
            this.outputChannel.appendLine('Logout attempt failed.');
             // Rethrow to signal failure to the caller
             throw error;
        }
    }

    public async getInfo(options: P4Options = {}): Promise<P4Result> {
        const result = await this.execute('info', [], options, true);
        // Parsing of result.parsedOutput would happen in the caller now
        return result;
    }

    private logCommand(command: string, args: string[], options: P4Options, input?: string): void {
        if (!this.debugMode) {return;}
        const cmdLine = `p4 ${command} ${args.join(' ')}`;
        this.outputChannel.appendLine(`Executing: ${cmdLine}`);
        this.outputChannel.appendLine(`  Options: ${JSON.stringify(options)}`);
        if (input) {
             this.outputChannel.appendLine(`  Input: ${input.substring(0, 100)}${input.length > 100 ? '...' : ''}`);
        }
        console.log(`Executing P4: ${cmdLine}`, options); // Also log to dev console if needed
    }

     private logOutput(stdout: string, stderr: string): void {
        if (!this.debugMode) {return;}
        if (stdout) {
            this.outputChannel.appendLine(`P4 STDOUT:\n${stdout}`);
            console.log(`P4 STDOUT:`, stdout);
        }
        // Always log stderr as it might contain warnings even on success
        if (stderr) {
            this.outputChannel.appendLine(`P4 STDERR:\n${stderr}`);
            console.warn(`P4 STDERR:`, stderr);
        }
    }

    private logError(command: string, args: string[], stderr: string): void {
        // Always log errors regardless of debug mode
        this.outputChannel.appendLine(`ERROR running p4 ${command} ${args.join(' ')}:\n${stderr}`);
        console.error(`Error running p4 ${command}`, args, stderr);
    }

    /**
     * Parses the Python Marshalled output from p4 -G commands.
     * @param stdout The raw standard output string from the p4 command.
     * @returns The parsed JavaScript object/array.
     * @throws Error if parsing fails.
     */
    private parseTaggedOutput(stdout: string): any {
        if (!stdout) {
            return null; // Or an empty array/object depending on expected output type?
        }

        try {
            // Convert the string stdout to a Buffer for the marshal parser.
            // IMPORTANT: Assuming the string encoding (e.g., from reckless-node-perforce)
            // correctly represents the raw bytes from the marshal data.
            // If reckless-node-perforce can provide a Buffer directly, that would be safer.
            // Let's assume UTF-8 is problematic and try Latin1 (ISO-8859-1) as it maps
            // byte values 0-255 directly to Unicode code points U+0000 to U+00FF.
            const buffer = Buffer.from(stdout, 'latin1');

            // Use the python-marshal library to load the data
            const parsedData = marshal.load(buffer);

            // P4 -G often returns a list of dictionaries.
            return parsedData;
        } catch (error: any) {
            this.outputChannel.appendLine(`Marshal parsing failed: ${error.message}`);
            console.error("Marshal parsing error:", error, "Input string (first 500 chars):", stdout.substring(0, 500));
            // Re-throw the error to be caught by the execute method's catch block
            throw new Error(`Failed to parse marshalled Python output: ${error.message}`);
        }
    }

    /**
     * Uses `p4 where` to find the local filesystem path for a given depot or client path.
     * Wrapper around the p4where command function.
     * @param depotOrClientPath The depot or client path (e.g., //depot/main/file.c or //clientname/main/file.c)
     * @param options P4 options (especially cwd might be relevant)
     * @returns The absolute local filesystem path, or null if not found/mapped.
     */
    public async getLocalPath(depotOrClientPath: string, options: P4Options = {}): Promise<string | null> {
        // Create the context required by the command function
        const context: P4CommandContext = {
            // Bind execute to this instance to maintain context
            execute: this.execute.bind(this), 
            outputChannel: this.outputChannel,
        };
        // Call the specific command function from fileCommands
        return p4where(context, depotOrClientPath, options);
    }

    dispose() {
        // Nothing specific to dispose here unless we add watchers etc.
    }
} 