import * as vscode from 'vscode';
import { PerforceService } from './PerforceService';
import { P4Options, P4Result } from './p4/p4Types'; // Import types directly

// Interface definitions for managed items (example)
export interface P4File {
    uri: vscode.Uri;
    depotPath: string;
    clientPath: string;
    localPath?: string; // Added: Resolved local filesystem path
    status: string; // e.g., 'edit', 'add', 'delete', 'integrate', 'branch', 'lock'
    changelist: string; // 'default' or changelist number
    revision?: string; // #rev
    headRevision?: string;
    haveRevision?: string;
    action?: string; // Specific action like 'edit', 'add'
    type?: string; // Filetype
    diffStatus?: string; // e.g. 'unresolved', 'reresolvable'
    isShelved?: boolean;
    shelvedInChangelist?: string;
    user?: string;
    client?: string;
}

export interface P4Changelist {
    id: string; // 'default' or number string
    description: string;
    user: string;
    client: string;
    status: 'pending' | 'submitted' | 'shelved';
    files: P4File[]; // Holds P4File objects associated with this changelist
    jobs?: string[]; // List of job IDs fixed
    isShelved?: boolean; // If the changelist itself represents shelved files
    hasShelvedFiles?: boolean; // If a pending changelist has associated shelved files
    isRestricted?: boolean; // e.g. from p4 changes -R
    date?: Date; // Add date field
}

export class RepositoryStateManager implements vscode.Disposable {
    private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChange = this._onDidChange.event;

    private files: Map<string, P4File> = new Map(); // Key: uri.toString()
    private changelists: Map<string, P4Changelist> = new Map(); // Key: changelist ID
    private perforceService: PerforceService;
    private outputChannel: vscode.OutputChannel;
    private isUpdating = false;
    private readonly p4Options: P4Options; // Store options

    constructor(perforceService: PerforceService, outputChannel: vscode.OutputChannel, options: P4Options) { // Accept options
        this.perforceService = perforceService;
        this.outputChannel = outputChannel;
        this.p4Options = options; // Store options
    }

    public async updateState(resourceUri?: vscode.Uri): Promise<void> {
         if (this.isUpdating) {
            this.outputChannel.appendLine('Skipping updateState: Already in progress.');
            return;
        }
        this.isUpdating = true;
        this.outputChannel.appendLine('Updating Perforce repository state...');

        // --- Preparation ---
        const previousChangeKeys = new Set(this.changelists.keys());
        previousChangeKeys.delete('default'); // Don't prune the default changelist implicitly

        // Clear existing file associations and the main map before fetching new data
        this.files.clear();
        this.changelists.forEach(change => {
             // Reset file lists for all changes, not just pending, to ensure clean state
            change.files = [];
        });
        this.ensureDefaultChangelist(); // Ensure default exists with empty files array

        try {
            // --- Fetch Data (populates this.files with placeholder URIs) ---
            this.outputChannel.appendLine('Executing `p4 opened -G`...');
            const openedResult = await this.perforceService.execute('opened', [], this.p4Options, true);
            const openedFiles = this.processP4Result(openedResult, this.parseOpenedOutput.bind(this), 'p4 opened');
             openedFiles.forEach(f => this.files.set(f.uri.toString(), f)); // Add to map using placeholder URI

            this.outputChannel.appendLine('Executing `p4 status -G`...');
            const statusResult = await this.perforceService.execute('status', [], this.p4Options, true);
            const statusFiles = this.processP4Result(statusResult, this.parseStatusOutput.bind(this), 'p4 status');
             // Merge status files into the map, potentially overwriting/updating info from 'opened'
             statusFiles.forEach(statusFile => {
                 const key = statusFile.uri.toString(); // Placeholder URI
                 const existingFile = this.files.get(key);
                 if (existingFile) {
                     // Merge status info into existing file from 'opened'
                     this.outputChannel.appendLine(`Merging status info into existing file: ${key} (Status: ${statusFile.status})`);
                     existingFile.status = statusFile.status;
                     existingFile.action = statusFile.action; // Let status override action? Or keep opened action? Let's try overriding.
                     existingFile.diffStatus = statusFile.diffStatus;
                     existingFile.depotPath = existingFile.depotPath || statusFile.depotPath; // Fill if missing
                     existingFile.clientPath = existingFile.clientPath || statusFile.clientPath; // Fill if missing
                     // Merge other potentially useful info
                     existingFile.user = existingFile.user ?? statusFile.user;
                     existingFile.client = existingFile.client ?? statusFile.client;
                     existingFile.revision = existingFile.revision ?? statusFile.revision;
                     existingFile.headRevision = existingFile.headRevision ?? statusFile.headRevision;
                     existingFile.haveRevision = existingFile.haveRevision ?? statusFile.haveRevision;
                     existingFile.type = existingFile.type ?? statusFile.type;
                 } else {
                     // Add new file found only by status
                      this.outputChannel.appendLine(`Adding new file from status: ${key} (Status: ${statusFile.status})`);
                     this.files.set(key, statusFile);
                 }
             });


            // --- Fetch Changelists (updates this.changelists, does not touch files yet) ---
            this.outputChannel.appendLine('Executing `p4 changes -s pending -l -G`...');
            const changesArgs = ['-s', 'pending', '-l'];
            if (this.p4Options.P4USER) {changesArgs.push('-u', this.p4Options.P4USER);}
            if (this.p4Options.P4CLIENT) {changesArgs.push('-c', this.p4Options.P4CLIENT);}
            const changesResult = await this.perforceService.execute('changes', changesArgs, this.p4Options, true);
            const pendingChanges = this.processP4Result(changesResult, this.parseChangesOutput.bind(this), 'p4 changes');
            const currentChangeKeys = this.updateChangelists(pendingChanges); // Updates CL data, keeps file lists empty

            // --- Fetch Shelved Files (adds to this.files map with placeholder URIs) ---
            const shelvedFilePromises: Promise<P4File[]>[] = [];
            this.changelists.forEach(change => {
                if (change.hasShelvedFiles && change.status === 'pending') {
                    this.outputChannel.appendLine(`Fetching shelved files for changelist ${change.id}...`);
                    const promise = this.perforceService.execute('describe', ['-s', '-S', change.id, '-G'], this.p4Options, true)
                        .then((result: P4Result) => this.processP4Result(result, (data) => this.parseDescribeOutput(data, change.id), `p4 describe ${change.id}`))
                        .catch((err: Error) => {
                            this.outputChannel.appendLine(`Failed to fetch/parse describe for ${change.id}: ${err.message}`);
                            return [];
                        });
                    shelvedFilePromises.push(promise);
                }
            });
            const allShelvedFilesNested = await Promise.all(shelvedFilePromises);
            const allShelvedFiles = allShelvedFilesNested.flat();
             // Merge shelved files into the map
             allShelvedFiles.forEach(shelvedFile => {
                 const key = shelvedFile.uri.toString(); // Placeholder URI
                 const existingFile = this.files.get(key);
                 if (existingFile) {
                     // Merge shelved info into existing file (e.g., from 'opened' or 'status')
                     this.outputChannel.appendLine(`Merging shelved status into existing file: ${key} (CL ${shelvedFile.changelist})`);
                     existingFile.isShelved = true;
                     existingFile.shelvedInChangelist = shelvedFile.changelist;
                     // Keep existing status/action from opened/status unless necessary to change
                 } else {
                      this.outputChannel.appendLine(`Adding new shelved file entry: ${key} (CL ${shelvedFile.changelist})`);
                     this.files.set(key, shelvedFile);
                 }
             });

            // --- Resolve URIs ---
            await this.resolveFileUris(); // Updates this.files map with file: URIs and removes unresolved

            // --- Re-associate Resolved Files with Changelists ---
            this.outputChannel.appendLine(`Re-associating ${this.files.size} resolved files with changelists...`);
            this.files.forEach(file => {
                const changeId = file.changelist;
                let change = this.changelists.get(changeId);
                if (!change) {
                    // Create placeholder for changelist if it wasn't fetched by 'p4 changes' but has resolved files
                     this.outputChannel.appendLine(`Creating placeholder for changelist ${changeId} based on resolved file.`);
                     change = {
                         id: changeId,
                         description: `Changelist ${changeId}`, // Basic description
                         user: file.user ?? this.p4Options.P4USER ?? 'unknown',
                         client: file.client ?? this.p4Options.P4CLIENT ?? 'unknown',
                         status: 'pending', // Assume pending if not explicitly known
                         files: [],
                         date: new Date() // Use current date as placeholder
                     };
                     this.changelists.set(changeId, change);
                     currentChangeKeys.add(changeId); // Ensure this doesn't get pruned later
                }
                
                // Add the file (with its potentially updated URI) to the changelist
                 if (!change.files.some(f => f.uri.toString() === file.uri.toString())) {
                    change.files.push(file);
                 }
            });


            // --- Prune Changelists ---
            previousChangeKeys.forEach(key => {
                if (!currentChangeKeys.has(key)) {
                    this.outputChannel.appendLine(`Pruning changelist no longer pending: ${key}`);
                    this.changelists.delete(key);
                }
            });

            // --- Finalize ---
            this.outputChannel.appendLine(`Finished updating Perforce repository state. Files: ${this.files.size}, Changes: ${this.changelists.size}`);
            this._onDidChange.fire();

        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            this.outputChannel.appendLine(`Error updating repository state: ${errorMsg}`);
            // Clear state on failure? Maybe better to leave potentially stale state.
            // this.files.clear();
            // this.changelists.clear();
            // this._onDidChange.fire();
        } finally {
            this.isUpdating = false;
        }
    }

    /**
     * Retrieves the stored state for a specific file URI.
     * @param uri The vscode.Uri of the file.
     * @returns The P4File state object, or undefined if not found.
     */
    public getFileState(uri: vscode.Uri): P4File | undefined {
        return this.files.get(uri.toString());
    }
    
    // Deprecated?: Replaced by getFileState
    public getFile(uri: vscode.Uri): P4File | undefined {
        return this.files.get(uri.toString());
    }

    public getChangelist(id: string): P4Changelist | undefined {
        return this.changelists.get(id);
    }

    public getAllFiles(): P4File[] {
		return Array.from(this.files.values());
	}

    public getAllChangelists(): P4Changelist[] {
        // TODO: Sort according to settings (ascending/descending)
        const changes = Array.from(this.changelists.values());
        // Example sorting (descending, default last)
        changes.sort((a, b) => {
            if (a.id === 'default') {return 1;}
            if (b.id === 'default') {return -1;}
            return parseInt(b.id, 10) - parseInt(a.id, 10);
        });
        return changes;
    }

    private ensureDefaultChangelist(): void { // Remove p4Options argument
        if (!this.changelists.has('default')) {
            this.changelists.set('default', {
                id: 'default',
                description: 'Default changelist',
                user: this.p4Options.P4USER ?? 'unknown', // Use stored options
                client: this.p4Options.P4CLIENT ?? 'unknown', // Use stored options
                status: 'pending',
                files: [], // Will be populated by file updates
                date: new Date() // Add a date for consistency
            });
        } else {
             // Ensure the default changelist's file list is reset if we aren't doing full clears
             const defaultChange = this.changelists.get('default');
             if (defaultChange) {
                 defaultChange.files = []; 
             }
        }
    }
    
    /** Helper to process P4Result, parse tagged output, and handle errors */
    private processP4Result<T>(result: P4Result, parseMethod: (data: any[]) => T[], commandName: string): T[] {
        if (result.parsedOutput) {
            try {
                 return parseMethod(result.parsedOutput);
            } catch (parseError: any) {
                 this.outputChannel.appendLine(`Error during parsing stage for \`${commandName}\`: ${parseError.message}`);
                 console.error(`Parsing error for ${commandName}`, parseError, result.parsedOutput);
            }
        } else if (result.stdout && !result.stderr) { // Only warn if stdout exists AND stderr is empty (might be marshal error in stderr)
             this.outputChannel.appendLine(`Warning: Could not parse tagged output for \`${commandName}\` (parsedOutput field empty). Raw stdout present but parsing may have failed in PerforceService.`);
             // Potentially attempt non-G parsing here if implemented
        } else if (!result.stdout && !result.stderr) {
             this.outputChannel.appendLine(`No output received from \`${commandName}\`.`);
        } else {
             // If stderr is present, PerforceService likely already logged the command failure or marshal parse error
             this.outputChannel.appendLine(`Command \`${commandName}\` likely failed or parsing error occurred (stderr was present). Check previous logs.`);
        }
        return []; // Return empty array if no parsable output or error occurred
    }

    // --- Parsing Methods ---

    private parseOpenedOutput(p4Data: any[]): P4File[] {
        this.outputChannel.appendLine(`Parsing tagged \`p4 opened\` output (${p4Data?.length ?? 0} items)...`);
        const files: P4File[] = [];
        if (!Array.isArray(p4Data)) {
             this.outputChannel.appendLine(`Error: Expected array from tagged output for 'opened', got ${typeof p4Data}`);
             console.error("Expected array from tagged output for 'opened'", p4Data);
             throw new Error("Invalid data format received from p4 opened -G"); // Throw to be caught by processP4Result
        }

        for (const record of p4Data) {
             if (typeof record !== 'object' || record === null || !record.depotFile || !record.action) {
                this.outputChannel.appendLine(`Warning: Skipping invalid/incomplete opened record: ${JSON.stringify(record)}`);
                continue;
             }

             const clientPath = record.clientFile;
             if (!clientPath) {
                 this.outputChannel.appendLine(`Warning: Skipping opened record missing clientFile: ${record.depotFile}`);
                 continue;
             }

             // Use depotPath for the placeholder URI path uniqueness, clientPath is stored separately
             const placeholderUri = vscode.Uri.parse(`perforce:${record.depotPath}`);

             const file: P4File = {
                 uri: placeholderUri, // Use placeholder URI
                 depotPath: record.depotFile,
                 clientPath: clientPath, // Store clientPath
                 // localPath: will be filled later
                 status: record.action,
                 action: record.action,
                 changelist: record.change ?? 'default',
                 revision: record.rev ? `#${record.rev}` : undefined,
                 headRevision: record.headRev ? `#${record.headRev}` : undefined,
                 haveRevision: record.haveRev ? `#${record.haveRev}` : undefined,
                 type: record.type,
                 user: record.user, // Add user if available
                 client: record.client, // Add client if available
                 // diffStatus needs 'p4 status' or 'p4 diff -sr'
                 // isShelved needs 'p4 describe -S' or similar
             };
             files.push(file);
        }
        this.outputChannel.appendLine(`Parsed ${files.length} files from \`p4 opened\`.`);
        return files;
    }

    private parseChangesOutput(p4Data: any[]): P4Changelist[] {
        this.outputChannel.appendLine(`Parsing tagged \`p4 changes\` output (${p4Data?.length ?? 0} items)...`);
        const changes: P4Changelist[] = [];
         if (!Array.isArray(p4Data)) {
             this.outputChannel.appendLine(`Error: Expected array from tagged output for 'changes', got ${typeof p4Data}`);
             console.error("Expected array from tagged output for 'changes'", p4Data);
             throw new Error("Invalid data format received from p4 changes -G"); // Throw to be caught by processP4Result
        }

        for (const record of p4Data) {
            if (typeof record !== 'object' || record === null || !record.change || !record.desc) {
                 this.outputChannel.appendLine(`Warning: Skipping invalid/incomplete changes record: ${JSON.stringify(record)}`);
                 continue;
            }
            
            // Convert Unix timestamp (string) to Date
            let changeDate = new Date(); // Default to now if parsing fails
            if (record.time) {
                try {
                    const timestamp = parseInt(record.time, 10);
                    if (!isNaN(timestamp)) {
                        changeDate = new Date(timestamp * 1000); // Convert seconds to milliseconds
                    }
                } catch (e: any) {
                     this.outputChannel.appendLine(`Warning: Could not parse timestamp "${record.time}" for changelist ${record.change}: ${e.message}`);
                }
            }

            const changelist: P4Changelist = {
                id: record.change,
                description: record.desc.trim(), // Trim whitespace from description
                user: record.user ?? 'unknown',
                client: record.client ?? 'unknown',
                // Ensure status is one of the allowed literal types
                status: (record.status === 'pending' || record.status === 'submitted' || record.status === 'shelved') ? record.status : 'pending', 
                date: changeDate,
                files: [], // Files will be added by updateFiles/describe
                // jobs: record.jobs, // Assuming jobs field exists if needed
                // isShelved: record.status === 'shelved', // Check if 'shelved' is a possible status from `p4 changes`
                 hasShelvedFiles: record.shelved === '1', // Heuristic: check if 'shelved' field exists and is '1' (needs verification)
                 isRestricted: record.changeType?.includes('restricted'), // Heuristic: check changeType (needs verification)
            };
            changes.push(changelist);
        }
        this.outputChannel.appendLine(`Parsed ${changes.length} changelists from \`p4 changes\`.`);
        return changes;
    }

    private parseDescribeOutput(p4Data: any[], changelistId: string): P4File[] {
        this.outputChannel.appendLine(`Parsing tagged \`p4 describe -s -S ${changelistId}\` output...`);
        const files: P4File[] = [];
        // p4 describe -G output is typically a list containing one dictionary for the changelist description
        if (!Array.isArray(p4Data) || p4Data.length === 0 || typeof p4Data[0] !== 'object' || p4Data[0] === null) {
            this.outputChannel.appendLine(`Error: Expected array with at least one object for 'describe ${changelistId}', got ${JSON.stringify(p4Data).substring(0, 200)}`);
            // Don't throw here, just return empty list - the command might succeed but have no shelved files
            return files;
        }
        
        const record = p4Data[0]; // The main changelist description object
        
        // Files are usually in fields like depotFile0, action0, type0, etc.
        let i = 0;
        while (record[`depotFile${i}`]) {
            const depotPath = record[`depotFile${i}`];
            const action = record[`action${i}`];
            const type = record[`type${i}`];
            const revision = record[`rev${i}`] ? `#${record[`rev${i}`]}` : undefined;
            const clientFile = record[`clientFile${i}`]; // May or may not be present depending on describe flags/context

            if (!depotPath) {
                this.outputChannel.appendLine(`Warning: Skipping invalid/incomplete describe record index ${i} for CL ${changelistId} (missing depotPath)`);
                i++;
                continue;
            }

            // Use depotPath for placeholder uniqueness
            const placeholderUri = vscode.Uri.parse(`perforce-shelved:${depotPath}`);

            const file: P4File = {
                uri: placeholderUri, // Use placeholder URI
                depotPath: depotPath,
                clientPath: clientFile ?? '', // Store clientPath if available, otherwise empty string
                // localPath: will be filled later
                status: action, // Use action as status for shelved files
                action: action,
                changelist: changelistId,
                revision: revision,
                type: type,
                isShelved: true,
                shelvedInChangelist: changelistId,
            };
            files.push(file);
            i++;
        }

        this.outputChannel.appendLine(`Parsed ${files.length} shelved files from \`p4 describe ${changelistId}\`.`);
        return files;
    }

    private parseStatusOutput(p4Data: any[]): P4File[] {
        this.outputChannel.appendLine(`Parsing tagged \`p4 status\` output (${p4Data?.length ?? 0} items)...`);
        const files: P4File[] = [];
        if (!Array.isArray(p4Data)) {
             this.outputChannel.appendLine(`Error: Expected array from tagged output for 'status', got ${typeof p4Data}`);
             console.error("Expected array from tagged output for 'status'", p4Data);
             throw new Error("Invalid data format received from p4 status -G");
        }

        for (const record of p4Data) {
            // Records can represent different things (open files, local changes, etc.)
            // Key fields: 'clientFile', 'depotFile', 'status', 'action'
            if (typeof record !== 'object' || record === null || (!record.clientFile && !record.depotFile)) {
                 this.outputChannel.appendLine(`Warning: Skipping invalid/incomplete status record: ${JSON.stringify(record)}`);
                 continue;
            }
            
            const clientFile = record.clientFile;
            const depotFile = record.depotFile;

            // Need a unique identifier for the placeholder URI.
            // Prefer clientFile if available, fallback to depotFile (e.g., for needsDelete)
            // If neither exists, we cannot create a meaningful placeholder.
            const pathForUri = clientFile || depotFile;
            if (!pathForUri) {
                 this.outputChannel.appendLine(`Warning: Skipping status record missing both clientFile and depotFile: ${JSON.stringify(record)}`);
                 continue;
            }

            // Use a consistent scheme, use the chosen path for uniqueness
            const placeholderUri = vscode.Uri.parse(`perforce:${pathForUri}`);

            // Determine the effective status/action - p4 status combines things
            let effectiveStatus = record.status ?? 'unknown';
            let effectiveAction = record.action ?? 'unknown'; // e.g., 'edit', 'add', 'delete', 'branch', 'integrate'
            let diffStatus: string | undefined;

            // Examples of combined statuses from `p4 status`:
            // 'edit' -> open for edit
            // 'add' -> open for add
            // 'delete' -> open for delete
            // 'needsAdd' -> local file not in depot
            // 'needsDelete' -> depot file not on local fs (or opened for delete)
            // 'modifiedNotOpened' -> local file modified, not open
            // 'notOpened+needsResolve' -> local file needs resolve, not open
            // 'openNeedsResolve' -> opened file needs resolve

            if (effectiveStatus.includes('Resolve')) {
                diffStatus = 'unresolved'; // Simplification, could be more specific
            }
            if (effectiveStatus === 'modifiedNotOpened') {
                effectiveAction = 'modify-local'; // Use a custom action for display?
            }
            if (effectiveStatus === 'needsAdd') {
                effectiveAction = 'add-local';
            }
             if (effectiveStatus === 'needsDelete') {
                effectiveAction = 'delete-local';
            }

            const file: P4File = {
                uri: placeholderUri, // Use placeholder URI
                depotPath: depotFile ?? '', // May be empty for local adds
                clientPath: clientFile ?? '', // Store clientFile if present
                // localPath: will be filled later
                status: effectiveStatus,
                action: effectiveAction,
                changelist: record.change ?? record.otherChange ?? 'default',
                revision: record.rev ? `#${record.rev}` : undefined,
                headRevision: record.headRev ? `#${record.headRev}` : undefined,
                haveRevision: record.haveRev ? `#${record.haveRev}` : undefined,
                type: record.type,
                user: record.user ?? record.otherUser, // May include info about other users locking/opening
                client: record.client ?? record.otherClient,
                diffStatus: diffStatus,
                isShelved: record.isShelved === '1', // Check if status reports shelved status?
            };
            files.push(file);
        }
        this.outputChannel.appendLine(`Parsed ${files.length} files from \`p4 status\`.`);
        return files;
    }

    // --- State Update Methods ---

    /** Updates files map and re-associates with changelists. Returns set of current file keys. */
    private updateFiles(newFiles: P4File[]): Set<string> {
        this.outputChannel.appendLine(`Updating files map with ${newFiles.length} opened files.`);
        const currentFileKeys = new Set<string>();
        
        // Clear existing files from pending changelists before adding new ones
        // Also clear the main file map to prepare for the new state
        this.changelists.forEach(change => {
            if (change.status === 'pending') { 
                change.files = [];
            }
        });
        this.files.clear();

        newFiles.forEach(file => {
            const key = file.uri.toString();
            this.files.set(key, file);
            currentFileKeys.add(key);

            // Add file to its corresponding changelist
            const changeId = file.changelist;
            let change = this.changelists.get(changeId);
            if (!change && changeId !== 'default') {
                // Placeholder for changelist seen via 'opened' but not yet via 'changes'
                 this.outputChannel.appendLine(`Creating placeholder for changelist ${changeId} based on opened file.`);
                 change = {
                     id: changeId,
                     description: `Changelist ${changeId}`,
                     user: file.user ?? this.p4Options.P4USER ?? 'unknown',
                     client: file.client ?? this.p4Options.P4CLIENT ?? 'unknown',
                     status: 'pending',
                     files: [],
                     date: new Date()
                 };
                 this.changelists.set(changeId, change);
            }
            
            // Add file to the list if the changelist exists
            if (change) {
                 // Check if already added to prevent duplicates if updateState is called rapidly?
                 if (!change.files.some(f => f.uri.toString() === key)) {
                    change.files.push(file);
                 }
            } else {
                 // This case should be less likely now due to the placeholder creation above
                 this.outputChannel.appendLine(`Warning: Could not find changelist ${changeId} to add file ${key}`);
            }
        });
        this.outputChannel.appendLine(`File map size after update: ${this.files.size}`);
        return currentFileKeys;
    }

    /** Updates changelist map with new data. Returns set of current pending changelist keys. */
    private updateChangelists(newChanges: P4Changelist[]): Set<string> {
        this.outputChannel.appendLine(`Updating changelist map with ${newChanges.length} pending changelists.`);
        const currentChangeKeys = new Set<string>();

        newChanges.forEach(change => {
            currentChangeKeys.add(change.id);
            const existing = this.changelists.get(change.id);
            if (existing) {
                // Merge properties, PRESERVING THE EMPTY existing.files array
                existing.description = change.description;
                existing.user = change.user;
                existing.client = change.client;
                existing.status = change.status;
                existing.jobs = change.jobs;
                existing.date = change.date;
                existing.hasShelvedFiles = change.hasShelvedFiles;
                existing.isRestricted = change.isRestricted;
                // Ensure files list remains empty here - it will be populated after URI resolution
                existing.files = []; 
            } else {
                // Add the new changelist (it already has an empty files list from parseChangesOutput)
                this.changelists.set(change.id, change);
            }
        });
         this.outputChannel.appendLine(`Changelist map size after update: ${this.changelists.size}`);
        return currentChangeKeys;
    }

    /** Updates state with shelved files, merging with existing files if necessary. */
    private updateShelvedFiles(shelvedFiles: P4File[]): void {
        this.outputChannel.appendLine(`Updating state with ${shelvedFiles.length} shelved files.`);
        
        shelvedFiles.forEach(shelvedFile => {
            const key = shelvedFile.uri.toString();
            const existingFile = this.files.get(key);
            
            if (existingFile) {
                // File exists (likely from 'p4 opened'). Merge shelved info.
                this.outputChannel.appendLine(`Merging shelved status into existing file: ${key} (CL ${shelvedFile.changelist})`);
                existingFile.isShelved = true;
                existingFile.shelvedInChangelist = shelvedFile.changelist;
                // Decide if shelved action/status overrides opened action/status? For now, keep opened status.
                // existingFile.status = shelvedFile.status; 
                // existingFile.action = shelvedFile.action;
            } else {
                // File doesn't exist, add it as a new shelved file entry
                this.outputChannel.appendLine(`Adding new shelved file entry: ${key} (CL ${shelvedFile.changelist})`);
                this.files.set(key, shelvedFile);
                
                // Also ensure it's added to the corresponding changelist's file list
                const change = this.changelists.get(shelvedFile.changelist);
                if (change) {
                    if (!change.files.some(f => f.uri.toString() === key)) {
                        change.files.push(shelvedFile);
                    }
                } else {
                    // Should be unlikely if we just fetched the changelist
                     this.outputChannel.appendLine(`Warning: Could not find parent changelist ${shelvedFile.changelist} for shelved file ${key}`);
                }
            }
        });
         this.outputChannel.appendLine(`File map size after shelved update: ${this.files.size}`);
    }

    /** Updates state based on `p4 status` output, merging with existing file info. */
    private updateStatusFiles(statusFiles: P4File[]): void {
        this.outputChannel.appendLine(`Updating state with ${statusFiles.length} files from p4 status.`);

        statusFiles.forEach(statusFile => {
            const key = statusFile.uri.toString();
            const existingFile = this.files.get(key);

            if (existingFile) {
                // File already known (from opened or describe). Update with status info.
                this.outputChannel.appendLine(`Updating existing file ${key} with status: ${statusFile.status}`);
                // Update fields that `p4 status` might provide or clarify
                existingFile.status = statusFile.status; // Overwrite status with the more detailed one from `p4 status`?
                existingFile.diffStatus = existingFile.diffStatus ?? statusFile.diffStatus; // Keep existing diffStatus if already set
                // Potentially update action if status implies something different?
                // e.g., if opened for edit but status says 'needsDelete'
                if (existingFile.action !== statusFile.action && statusFile.action !== 'unknown') {
                    this.outputChannel.appendLine(` Action mismatch for ${key}: opened='${existingFile.action}', status='${statusFile.action}'. Keeping opened action for now.`);
                    // Decide on merging strategy - keeping the 'opened' action seems safer usually.
                }
                 // Merge other potentially useful info if missing from opened/describe?
                 existingFile.user = existingFile.user ?? statusFile.user;
                 existingFile.client = existingFile.client ?? statusFile.client;
                 existingFile.revision = existingFile.revision ?? statusFile.revision;
                 existingFile.headRevision = existingFile.headRevision ?? statusFile.headRevision;
                 existingFile.haveRevision = existingFile.haveRevision ?? statusFile.haveRevision;
                 existingFile.type = existingFile.type ?? statusFile.type;

            } else {
                // File not previously known (e.g., modified locally, needs add/delete)
                this.outputChannel.appendLine(`Adding new file ${key} from status: ${statusFile.status}`);
                this.files.set(key, statusFile);

                // Add this file to the default changelist if not already associated elsewhere
                const change = this.changelists.get('default');
                if (change) {
                    if (!change.files.some(f => f.uri.toString() === key)) {
                        change.files.push(statusFile);
                    }
                } else {
                    this.outputChannel.appendLine(`Warning: Default changelist not found when adding file from status: ${key}`);
                }
            }
        });
        this.outputChannel.appendLine(`File map size after status update: ${this.files.size}`);
    }

    /**
     * Resolves placeholder URIs ('perforce:', 'perforce-shelved:') to 'file:' URIs
     * by querying the local path for each unique clientPath using `p4 where` or similar.
     * Updates file.uri and file.localPath on success.
     * Removes files from the state if their clientPath cannot be resolved locally.
     */
    private async resolveFileUris(): Promise<void> {
        this.outputChannel.appendLine('Resolving file URIs...');
        const filesToResolve = Array.from(this.files.values());
        const uniqueClientPaths = [
            ...new Set(
                filesToResolve
                    .map((f) => f.clientPath)
                    .filter((cp): cp is string => !!cp && cp.length > 0) // Filter out empty/undefined paths
            ),
        ];

        if (uniqueClientPaths.length === 0) {
            this.outputChannel.appendLine('No client paths found to resolve.');
            return;
        }

        this.outputChannel.appendLine(`Found ${uniqueClientPaths.length} unique client paths to query.`);

        // Resolve paths in parallel
        const resolutionPromises = uniqueClientPaths.map(async (clientPath) => {
            try {
                // Assuming getLocalPath exists and handles mapping client->local
                const localPath = await this.perforceService.getLocalPath(clientPath, this.p4Options);
                return { clientPath, localPath }; // localPath can be null if mapping fails
            } catch (error: any) {
                this.outputChannel.appendLine(`Error resolving local path for "${clientPath}": ${error.message}`);
                return { clientPath, localPath: null }; // Treat errors as unresolved
            }
        });

        const resolutions = await Promise.all(resolutionPromises);
        const resolvedPathMap = new Map<string, string | null>();
        resolutions.forEach(r => resolvedPathMap.set(r.clientPath, r.localPath));

        this.outputChannel.appendLine(`Finished querying local paths. Updating file URIs...`);

        const resolvedFileKeys = new Set<string>();
        const unresolvedFiles: string[] = []; // Store URIs of files to remove

        // Iterate through the original list, as `this.files` map might change during iteration if we remove items
        for (const file of filesToResolve) {
            const key = file.uri.toString(); // The placeholder URI string
            if (!file.clientPath || file.clientPath.length === 0) {
                 this.outputChannel.appendLine(`Skipping file with empty client path: ${key}`);
                 // Keep the file with its placeholder URI if it has no client path? Or remove?
                 // Let's remove it, as it's unlikely to be useful without a client path.
                 unresolvedFiles.push(key);
                 continue;
            }

            const localPath = resolvedPathMap.get(file.clientPath);

            if (localPath) {
                try {
                    const newUri = vscode.Uri.file(localPath);
                    const newKey = newUri.toString();

                     // Check if another file already resolved to this same local path
                     if (resolvedFileKeys.has(newKey) && key !== newKey) {
                          this.outputChannel.appendLine(`Warning: Multiple client paths resolved to the same local URI "${newKey}". Original placeholder: ${key}, ClientPath: ${file.clientPath}. Keeping first occurrence.`);
                          // Remove the duplicate entry
                          unresolvedFiles.push(key);
                          continue;
                     }

                    this.outputChannel.appendLine(` Resolved "${file.clientPath}" -> "${localPath}"`);
                    file.localPath = localPath;
                    file.uri = newUri; // Update the URI to the resolved file URI

                    // If the URI changed, we need to update the map key
                    if (key !== newKey) {
                        this.files.delete(key); // Remove old placeholder key
                        this.files.set(newKey, file); // Add with new file: URI key
                        resolvedFileKeys.add(newKey);
                    } else {
                         // This case should be rare (placeholder happened to be identical to file: URI)
                         resolvedFileKeys.add(key);
                    }
                } catch (uriError: any) {
                    this.outputChannel.appendLine(`Error creating file URI for resolved path "${localPath}" (from clientPath "${file.clientPath}"): ${uriError.message}. Removing file.`);
                    unresolvedFiles.push(key); // Mark for removal
                }
            } else {
                this.outputChannel.appendLine(` Failed to resolve local path for client path "${file.clientPath}". Removing file: ${key}`);
                unresolvedFiles.push(key); // Mark for removal
            }
        }

        // Remove files that couldn't be resolved or caused errors
        unresolvedFiles.forEach(key => {
            this.files.delete(key);
        });

        this.outputChannel.appendLine(`Finished resolving URIs. Final file count: ${this.files.size}.`);
    }

    dispose() {
        this._onDidChange.dispose();
        this.files.clear();
        this.changelists.clear();
    }
} 