import {
  RepositoryStateManager,
  P4File,
  P4Changelist,
} from "../RepositoryStateManager";
import { PerforceService } from "../PerforceService";
import * as vscode from "vscode"; // Minimal mock needed for Uri

// --- Mocks ---
// Mock PerforceService - we only need its presence for the constructor
const mockPerforceService = {} as PerforceService;

// Mock OutputChannel - provide dummy methods
const mockOutputChannel: vscode.OutputChannel = {
  name: "mock",
  append: jest.fn(),
  appendLine: jest.fn(),
  clear: jest.fn(),
  show: jest.fn(),
  hide: jest.fn(),
  dispose: jest.fn(),
  replace: jest.fn(),
};

describe("RepositoryStateManager Parsing Methods", () => {
  let stateManager: RepositoryStateManager;
  const mockOptions = { P4USER: "testuser", P4CLIENT: "testclient_ws" };

  beforeEach(() => {
    // Re-initialize before each test for isolation
    stateManager = new RepositoryStateManager(
      mockPerforceService,
      mockOutputChannel,
      mockOptions,
    );
    // Clear mock function calls
    jest.clearAllMocks();
  });

  // --- Test parseOpenedOutput ---
  describe("parseOpenedOutput", () => {
    it("should parse valid p4 opened -G output", () => {
      const p4Data = [
        {
          code: "stat",
          depotFile: "//depot/main/file1.txt",
          clientFile: "/path/to/file1.txt",
          rev: "1",
          action: "edit",
          change: "default",
          type: "text",
          user: "user1",
          client: "client1",
        },
        {
          code: "stat",
          depotFile: "//depot/dev/file2.bin",
          clientFile: "/path/to/file2.bin",
          headRev: "3",
          haveRev: "3",
          action: "add",
          change: "12345",
          type: "binary",
          user: "user2",
          client: "client2",
        },
        {
          code: "stat",
          depotFile: "//depot/main/file3.txt",
          clientFile: "/path/to/file3.txt",
          rev: "none",
          action: "delete",
          change: "12345",
          type: "text",
          user: "user1",
          client: "client1",
        },
      ];
      const expectedFiles: P4File[] = [
        {
          uri: vscode.Uri.parse("perforce://depot/main/file1.txt"),
          depotPath: "//depot/main/file1.txt",
          clientPath: "/path/to/file1.txt",
          status: "edit",
          action: "edit",
          changelist: "default",
          revision: "#1",
          headRevision: undefined,
          haveRevision: undefined,
          type: "text",
          user: "user1",
          client: "client1",
        },
        {
          uri: vscode.Uri.parse("perforce://depot/dev/file2.bin"),
          depotPath: "//depot/dev/file2.bin",
          clientPath: "/path/to/file2.bin",
          status: "add",
          action: "add",
          changelist: "12345",
          revision: undefined,
          headRevision: "#3",
          haveRevision: "#3",
          type: "binary",
          user: "user2",
          client: "client2",
        },
        {
          uri: vscode.Uri.parse("perforce://depot/main/file3.txt"),
          depotPath: "//depot/main/file3.txt",
          clientPath: "/path/to/file3.txt",
          status: "delete",
          action: "delete",
          changelist: "12345",
          revision: "#none",
          headRevision: undefined,
          haveRevision: undefined,
          type: "text",
          user: "user1",
          client: "client1",
        },
      ];

      // Access private method
      const result = (stateManager as any).parseOpenedOutput(p4Data);
      expect(result).toHaveLength(expectedFiles.length);
      result.forEach((file: Partial<P4File>, index: number) => {
        expect(file).toMatchObject(expectedFiles[index]);
      });
    });

    it("should skip records missing essential fields", () => {
      const p4Data = [
        {
          code: "stat",
          clientFile: "/path/to/file1.txt",
          action: "edit",
          change: "default",
        }, // Missing depotFile
        { code: "stat", depotFile: "//depot/main/file2.txt", change: "12345" }, // Missing action/clientFile
        {
          code: "stat",
          depotFile: "//depot/valid/file.txt",
          clientFile: "/path/valid/file.txt",
          action: "edit",
          change: "default",
          type: "text",
        }, // Valid
      ];
      const result = (stateManager as any).parseOpenedOutput(p4Data);
      expect(result).toHaveLength(1);
      expect(result[0].depotPath).toBe("//depot/valid/file.txt");
    });

    it("should handle empty input", () => {
      const p4Data: any[] = [];
      const result = (stateManager as any).parseOpenedOutput(p4Data);
      expect(result).toEqual([]);
    });

    it("should throw if input is not an array", () => {
      const p4Data = { not: "an array" };
      // We expect processP4Result to catch this, but test the parser directly
      expect(() => (stateManager as any).parseOpenedOutput(p4Data)).toThrow(
        /Invalid data format/,
      );
    });
  });

  // --- Test parseChangesOutput ---
  describe("parseChangesOutput", () => {
    it("should parse valid p4 changes -G output", () => {
      const p4Data = [
        {
          change: "12345",
          time: "1678886400",
          user: "user1",
          client: "client1",
          status: "pending",
          changeType: "public",
          path: "//client1/...",
          desc: "Initial commit\nWith multiple lines\n",
          shelved: "1",
        },
        {
          change: "12300",
          time: "1678800000",
          user: "user2",
          client: "client2",
          status: "pending",
          changeType: "public restricted",
          path: "//client2/...",
          desc: "Another change",
        },
      ];
      const expectedChanges: Partial<P4Changelist>[] = [
        // Partial for easier comparison
        {
          id: "12345",
          description: "Initial commit\nWith multiple lines",
          user: "user1",
          client: "client1",
          status: "pending",
          files: [],
          date: new Date(1678886400 * 1000),
          hasShelvedFiles: true,
          isRestricted: false,
        },
        {
          id: "12300",
          description: "Another change",
          user: "user2",
          client: "client2",
          status: "pending",
          files: [],
          date: new Date(1678800000 * 1000),
          hasShelvedFiles: false,
          isRestricted: true,
        },
      ];

      const result = (stateManager as any).parseChangesOutput(p4Data);
      // Compare specific fields as date object comparison can be tricky
      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject(expectedChanges[0]);
      expect(result[1]).toMatchObject(expectedChanges[1]);
    });

    it("should handle missing optional fields gracefully", () => {
      const p4Data = [
        {
          change: "999",
          time: "1678886400",
          user: "user1",
          client: "client1",
          status: "pending",
          desc: "Minimal change",
        },
      ];
      const result = (stateManager as any).parseChangesOutput(p4Data);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("999");
      expect(result[0].hasShelvedFiles).toBe(false); // Default
      expect(result[0].isRestricted).toBe(false); // Default
    });

    it("should handle invalid timestamp", () => {
      const p4Data = [
        {
          change: "998",
          time: "invalid-time",
          user: "user1",
          client: "client1",
          status: "pending",
          desc: "Bad time",
        },
      ];
      const result = (stateManager as any).parseChangesOutput(p4Data);
      expect(result).toHaveLength(1);
      // Check if date is roughly 'now' (the default fallback)
      expect(result[0].date.getTime()).toBeGreaterThan(Date.now() - 5000);
      expect(result[0].date.getTime()).toBeLessThan(Date.now() + 5000);
    });

    it("should handle empty input", () => {
      const p4Data: any[] = [];
      const result = (stateManager as any).parseChangesOutput(p4Data);
      expect(result).toEqual([]);
    });

    it("should throw if input is not an array", () => {
      const p4Data = { not: "an array" };
      expect(() => (stateManager as any).parseChangesOutput(p4Data)).toThrow(
        /Invalid data format/,
      );
    });
  });

  // --- Test parseDescribeOutput ---
  describe("parseDescribeOutput", () => {
    it("should parse valid p4 describe -s -S -G output", () => {
      const changelistId = "12345";
      const p4Data = [
        {
          change: changelistId,
          desc: "Shelved files",
          user: "user1",
          status: "pending",
          depotFile0: "//depot/shelved/fileA.txt",
          action0: "edit",
          type0: "text",
          rev0: "1",
          clientFile0: "/path/to/fileA.txt",
          depotFile1: "//depot/shelved/fileB.bin",
          action1: "add",
          type1: "binary",
          rev1: "1", // No clientFile for add?
        },
      ];
      const expectedFiles: P4File[] = [
        {
          uri: vscode.Uri.parse("perforce-shelved://depot/shelved/fileA.txt"),
          depotPath: "//depot/shelved/fileA.txt",
          clientPath: "/path/to/fileA.txt",
          status: "edit",
          action: "edit",
          changelist: changelistId,
          revision: "#1",
          type: "text",
          isShelved: true,
          shelvedInChangelist: changelistId,
        },
        {
          uri: vscode.Uri.parse("perforce-shelved://depot/shelved/fileB.bin"),
          depotPath: "//depot/shelved/fileB.bin",
          clientPath: "",
          status: "add",
          action: "add",
          changelist: changelistId,
          revision: "#1",
          type: "binary",
          isShelved: true,
          shelvedInChangelist: changelistId,
        },
      ];

      const result = (stateManager as any).parseDescribeOutput(
        p4Data,
        changelistId,
      );
      expect(result).toEqual(expectedFiles);
    });

    it("should return empty array if no files described", () => {
      const changelistId = "54321";
      const p4Data = [
        {
          change: changelistId,
          desc: "No shelved files",
          user: "user1",
          status: "pending",
        },
      ];
      const result = (stateManager as any).parseDescribeOutput(
        p4Data,
        changelistId,
      );
      expect(result).toEqual([]);
    });

    it("should return empty array for empty input", () => {
      const changelistId = "111";
      const p4Data: any[] = [];
      const result = (stateManager as any).parseDescribeOutput(
        p4Data,
        changelistId,
      );
      expect(result).toEqual([]);
    });

    it("should return empty array if input is not array or invalid structure", () => {
      const changelistId = "222";
      const p4Data = { not: "an array" };
      const result = (stateManager as any).parseDescribeOutput(
        p4Data,
        changelistId,
      );
      expect(result).toEqual([]); // Doesn't throw, just logs error and returns []
    });
  });

  // --- Test parseStatusOutput ---
  describe("parseStatusOutput", () => {
    it("should parse various p4 status -G outputs", () => {
      const p4Data = [
        { clientFile: "/path/to/local/add.txt", status: "needsAdd" }, // Local file not in depot
        {
          depotFile: "//depot/main/deleted.txt",
          status: "needsDelete",
          clientFile: "/path/to/deleted.txt",
          haveRev: "2",
        }, // Depot file missing locally
        {
          depotFile: "//depot/main/modified.txt",
          status: "modifiedNotOpened",
          clientFile: "/path/to/modified.txt",
          haveRev: "1",
        }, // Modified locally, not opened
        {
          depotFile: "//depot/main/edit.txt",
          status: "edit",
          clientFile: "/path/to/edit.txt",
          change: "default",
          action: "edit",
          type: "text",
          rev: "1",
          haveRev: "1",
        }, // Open for edit
        {
          depotFile: "//depot/main/resolve.txt",
          status: "openNeedsResolve",
          clientFile: "/path/to/resolve.txt",
          change: "12345",
          action: "integrate",
          rev: "3",
          haveRev: "2",
        }, // Open needs resolve
      ];

      const expectedFiles: Partial<P4File>[] = [
        // Using Partial for easier checks
        {
          uri: vscode.Uri.parse("perforce:/path/to/local/add.txt"),
          depotPath: "",
          clientPath: "/path/to/local/add.txt",
          status: "needsAdd",
          action: "add-local",
          changelist: "default",
        },
        {
          uri: vscode.Uri.parse("perforce://depot/main/deleted.txt"),
          depotPath: "//depot/main/deleted.txt",
          clientPath: "/path/to/deleted.txt",
          status: "needsDelete",
          action: "delete-local",
          changelist: "default",
          haveRevision: "#2",
        },
        {
          uri: vscode.Uri.parse("perforce://depot/main/modified.txt"),
          depotPath: "//depot/main/modified.txt",
          clientPath: "/path/to/modified.txt",
          status: "modifiedNotOpened",
          action: "modify-local",
          changelist: "default",
          haveRevision: "#1",
        },
        {
          uri: vscode.Uri.parse("perforce://depot/main/edit.txt"),
          depotPath: "//depot/main/edit.txt",
          clientPath: "/path/to/edit.txt",
          status: "edit",
          action: "edit",
          changelist: "default",
          revision: "#1",
          haveRevision: "#1",
          type: "text",
        },
        {
          uri: vscode.Uri.parse("perforce://depot/main/resolve.txt"),
          depotPath: "//depot/main/resolve.txt",
          clientPath: "/path/to/resolve.txt",
          status: "openNeedsResolve",
          action: "integrate",
          changelist: "12345",
          revision: "#3",
          haveRevision: "#2",
          diffStatus: "unresolved",
        },
      ];

      const result = (stateManager as any).parseStatusOutput(p4Data);
      expect(result).toHaveLength(expectedFiles.length);
      result.forEach((file: Partial<P4File>, index: number) => {
        expect(file).toMatchObject(expectedFiles[index]);
      });
    });

    it("should skip records missing clientFile and depotFile", () => {
      const p4Data = [
        { status: "someStatus" }, // No file path
        { clientFile: "/path/valid.txt", status: "needsAdd" }, // Valid
      ];
      const result = (stateManager as any).parseStatusOutput(p4Data);
      expect(result).toHaveLength(1);
      expect(result[0].clientPath).toBe("/path/valid.txt");
    });

    it("should handle empty input", () => {
      const p4Data: any[] = [];
      const result = (stateManager as any).parseStatusOutput(p4Data);
      expect(result).toEqual([]);
    });

    it("should throw if input is not an array", () => {
      const p4Data = { not: "an array" };
      expect(() => (stateManager as any).parseStatusOutput(p4Data)).toThrow(
        /Invalid data format/,
      );
    });
  });
});
