import * as assert from "assert";
import * as vscode from "vscode";
import { suite, test, teardown } from "mocha";

suite("Extension Integration Test Suite", () => {
  test("Extension should be present", async function () {
    // Use your actual extension ID
    const ext = vscode.extensions.getExtension(
      "ebextensions.perforce-new-2025",
    );
    assert.ok(ext, "Extension should be present");
    await ext?.activate();
  });

  test("Should be able to open and modify a text document", async function () {
    // Create a new file
    const doc = await vscode.workspace.openTextDocument({
      content: "Hello, World!",
      language: "plaintext",
    });

    // Show the document
    await vscode.window.showTextDocument(doc);

    // Verify content
    assert.strictEqual(doc.getText(), "Hello, World!");

    // Make an edit
    const edit = new vscode.WorkspaceEdit();
    edit.insert(doc.uri, new vscode.Position(0, 13), " From Test!");
    await vscode.workspace.applyEdit(edit);

    // Verify the edit
    assert.strictEqual(doc.getText(), "Hello, World! From Test!");
  });

  test("Should be able to execute built-in commands", async function () {
    // Use a built-in VS Code command instead
    await vscode.commands.executeCommand(
      "workbench.action.files.newUntitledFile",
    );

    // Get the active text editor after creating a new file
    const editor = vscode.window.activeTextEditor;
    assert.ok(
      editor !== undefined,
      "Editor should be available after creating new file",
    );
  });

  test("Should handle workspace configuration", async function () {
    const config = vscode.workspace.getConfiguration("perforce");
    const someValue = config.get("activationMode");
    assert.ok(someValue !== undefined);
  });

  teardown(async function () {
    // Clean up workspace
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });
});
