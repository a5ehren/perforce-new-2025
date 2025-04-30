import * as vscode from "vscode";
import { P4Options } from "./p4Types";

/**
 * Helper function to get P4 options from VS Code configuration for a specific resource.
 * Reads settings like p4.client, p4.user, p4.port, p4.password, p4.charset,
 * p4.dir (for cwd), and p4.command (for p4Path).
 *
 * @param resourceUri Optional URI to determine workspace-specific settings.
 * @returns P4Options object populated from configuration.
 */
export function getP4OptionsFromConfig(resourceUri?: vscode.Uri): P4Options {
  const config = vscode.workspace.getConfiguration("perforce", resourceUri);
  const options: P4Options = {};

  const client = config.get<string>("client");
  if (client && client !== "none") {
    options.P4CLIENT = client;
  }

  const user = config.get<string>("user");
  if (user && user !== "none") {
    options.P4USER = user;
  }

  const port = config.get<string>("port");
  if (port && port !== "none") {
    options.P4PORT = port;
  }

  const password = config.get<string>("password");
  if (password && password !== "none") {
    options.P4PASSWD = password;
  }

  const charset = config.get<string>("charset");
  if (charset && charset !== "none") {
    options.P4CHARSET = charset;
  }

  // P4CONFIG is often better left to the environment, but allow override if specified
  // const p4configSetting = config.get<string>('p4config'); // If we add a specific setting
  // if (p4configSetting) options.P4CONFIG = p4configSetting;

  const dir = config.get<string>("dir");
  if (dir && dir !== "none") {
    options.cwd = dir; // reckless-node-perforce uses 'cwd'
  } else if (resourceUri && vscode.workspace.getWorkspaceFolder(resourceUri)) {
    // Default cwd to the workspace folder containing the resource, if 'perforce.dir' isn't set
    options.cwd = vscode.workspace.getWorkspaceFolder(resourceUri)?.uri.fsPath;
  } else if (
    vscode.workspace.workspaceFolders &&
    vscode.workspace.workspaceFolders.length > 0
  ) {
    // Fallback to the first workspace folder if no resource is provided
    options.cwd = vscode.workspace.workspaceFolders[0].uri.fsPath;
  }

  // Check for the command path override
  const commandPath = config.get<string>("command");
  if (commandPath && commandPath !== "none") {
    options.p4Path = commandPath;
  }

  return options;
}
