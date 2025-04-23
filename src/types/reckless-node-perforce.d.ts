// Basic type declarations for reckless-node-perforce
// This provides minimal type safety. Enhance as needed based on library usage.

declare module 'reckless-node-perforce' {
    interface P4CommandResult {
        stdout: string | null;
        stderr: string | null;
        // Add other potential properties if the library returns them
    }

    interface P4CommandOptions {
        cwd?: string;
        p4Path?: string;
        P4CLIENT?: string;
        P4USER?: string;
        P4PORT?: string;
        P4PASSWD?: string;
        P4CHARSET?: string;
        P4CONFIG?: string;
        // Define other options the library accepts
        [key: string]: any; // Allow other string-keyed properties
    }

    /**
     * Executes a Perforce command.
     * @param command The p4 command (e.g., 'edit').
     * @param args An array of arguments for the command.
     * @param options Optional settings like cwd, environment variables.
     * @returns A promise that resolves with the command result or rejects on error.
     */
    function p4(command: string, args?: string[], options?: P4CommandOptions): Promise<P4CommandResult>;

    // If the library exports other functions or classes, declare them here.
    // For example, if it had a class:
    // export class P4Executable { ... }

    export = p4; // Assuming the default export is the main function
} 