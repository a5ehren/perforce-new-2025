import * as vscode from 'vscode';

// Interface for Perforce command options (environment, cwd)
// Match options potentially used by reckless-node-perforce or needed for p4 commands
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

// Interface for the result of a p4 command
export interface P4Result {
    stdout: string;
    stderr: string;
    // Potentially add parsed data later (e.g., parsed JSON from -G)
    parsedOutput?: any;
}

// Interface for files reported by p4 opened -G
// Based on common fields, may need refinement based on actual marshal output
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

// Interface for files reported by p4 status -G
// Fields based on typical p4 status output, verify with actual marshal output
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

// Interface for parsed annotation line data
export interface P4Annotation {
    line: number;
    change: string; // Changelist number
    user?: string;   // Optional: from -c flag
    client?: string; // Optional: from -c flag
    date?: string;   // Optional: from -c flag
}

// Interface for parsed filelog entry data
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

// Consider adding a specific type for parsed describe output
export interface P4DescribeResult {
    // Based on p4 describe -G output structure
    change: string;       // Changelist number
    user: string;
    client: string;
    time: string;         // Epoch timestamp
    desc: string;         // Description
    status: 'pending' | 'submitted' | 'shelved';
    changeType: 'public' | 'restricted';
    path?: string[];      // Optional?
    depotFile?: string[]; // Files in the changelist
    action?: string[];    // Action per file (edit, add, delete)
    type?: string[];      // File type per file
    rev?: string[];       // Revision per file
    // Add other fields as needed (e.g., jobStatus for pending changes)
}

// Represents a single entry from `p4 changes -G`
export interface P4ChangeSummary {
    change: string;
    time: string; // Epoch time
    user: string;
    client: string;
    status: 'pending' | 'submitted' | 'shelved';
    changeType: 'public' | 'restricted';
    path?: string; // Optional?
    desc: string;
}

// Represents a single entry from `p4 jobs -G`
export interface P4JobSummary {
    Job: string;
    Status: string;
    User: string;
    Date: string; // Usually YYYY/MM/DD format
    Description: string; // Typically truncated
    // Note: Field names often start with uppercase in job output
    // Add other common fields if needed, check `p4 fields` output
}

// Add the new interface for p4 info results
export interface P4Info {
    userName: string;
    clientName: string;
    clientHost?: string;
    clientRoot?: string;
    serverAddress?: string;
    serverVersion?: string;
    serverLicense?: string;
    caseHandling?: string;
    // Add other relevant fields from p4 info if needed
}

// Raw diff output is usually just a string

// Raw resolve output is usually just a string, indicating actions
// or launch of merge tool.

// Define the type for the execute function signature used by commands
export type ExecuteFunction = (
    command: string,
    args?: string[],
    options?: P4Options,
    useTaggedOutput?: boolean,
    input?: string
) => Promise<P4Result>;

// Define the context required by command functions
export interface P4CommandContext {
    execute: ExecuteFunction;
    outputChannel: vscode.OutputChannel;
} 