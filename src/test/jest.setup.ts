// src/test/jest.setup.ts
import * as vscode from 'vscode'; // Import the actual type for casting

// Global mock for the 'vscode' module
jest.mock('vscode', () => {
    // Keep the registry and creation logic entirely within the mock factory scope
    const mockUriRegistry = new Map<string, vscode.Uri>();

    const createMockUri = (scheme: string, path: string): vscode.Uri => {
        const key = `${scheme}:${path}`;
        // console.log(`DEBUG: createMockUri called with scheme='${scheme}', path='${path}' (key='${key}')`); // Debug log
        if (!mockUriRegistry.has(key)) {
            const actualPath = String(path ?? ''); // Ensure path is a string

            // Create the mock object directly here
            const mockUri = {
                scheme,
                authority: '',
                path: actualPath, // *** Explicitly assigning the path passed in ***
                query: '',
                fragment: '',
                fsPath: scheme === 'file' ? actualPath : `/mock/non-fs/${scheme}/${actualPath.replace(/^\//, '')}`,
                with: jest.fn().mockReturnThis(),
                toString: jest.fn().mockReturnValue(key),
                toJSON: jest.fn().mockReturnValue({ scheme, path: actualPath }) // Use actualPath here too
            } as unknown as vscode.Uri;
            // console.log(`DEBUG: Created mock URI for key='${key}':`, JSON.stringify(mockUri.toJSON())); // Debug log
            mockUriRegistry.set(key, mockUri);
        }
        // console.log(`DEBUG: Returning mock URI for key='${key}' from registry`); // Debug log
        return mockUriRegistry.get(key)!;
    };

    // Clear registry before each test run automatically via Jest setup
    // (This is handled by putting the registry definition inside the factory function)
    // Alternatively, if issues persist, explicitly clear in beforeEach in the setup file:
    // afterEach(() => { // or beforeEach
    //     mockUriRegistry.clear();
    // });


    return {
        Uri: {
            parse: jest.fn().mockImplementation((value: string) => {
                // console.log(`DEBUG: Uri.parse mock received: '${value}'`); // Debug log
                const separatorIndex = value.indexOf(':');
                if (separatorIndex === -1) {
                     console.warn(`Mock Uri.parse received potentially invalid string: ${value}`);
                     // Pass the whole value as path if no scheme separator
                     return createMockUri('unknown', value);
                }
                const scheme = value.substring(0, separatorIndex);
                // Get everything after the first ':' as the path part
                const pathPart = value.substring(separatorIndex + 1);
                // console.log(`DEBUG: Uri.parse calling createMockUri with scheme='${scheme}', pathPart='${pathPart}'`); // Debug log
                return createMockUri(scheme, pathPart);
            }),
            file: jest.fn().mockImplementation((path: string) => {
                // console.log(`DEBUG: Uri.file mock received: '${path}'`); // Debug log
                return createMockUri('file', path);
            }),
        },
        EventEmitter: jest.fn().mockImplementation(() => ({
            event: jest.fn(),
            fire: jest.fn(),
            dispose: jest.fn()
        })),
        // Add other mocks if needed
    };
}, { virtual: true });

// Ensure registry is cleared before each test if not handled automatically by scope
// beforeEach(() => {
//     // Accessing mockUriRegistry here might be tricky due to scope,
//     // relying on the factory function re-running might be sufficient.
//     // If needed, expose the registry or clear method globally (less ideal).
// });

// Mock VSCode API
const mockVSCode = {
    extensions: {
        getExtension: jest.fn(),
    },
    commands: {
        executeCommand: jest.fn(),
    },
    workspace: {
        openTextDocument: jest.fn(),
        applyEdit: jest.fn(),
        getConfiguration: jest.fn(),
    },
    window: {
        showTextDocument: jest.fn(),
    },
    WorkspaceEdit: jest.fn(),
    Position: jest.fn(),
    Uri: {
        file: jest.fn(),
    },
};

// Add VSCode API to global scope
(global as any).vscode = mockVSCode;

// Export for use in tests
export { mockVSCode };