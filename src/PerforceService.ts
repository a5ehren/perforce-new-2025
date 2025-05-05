import * as vscode from "vscode";
import * as childProcess from "child_process";
const marshal = require("py-marshal"); // Import the parser library

// Import necessary types from the new file
import { P4Options, P4Result } from "./p4/p4Types";
// Import the specific command and context we need
import { p4where, P4CommandContext } from "./p4/fileCommands";

export class PerforceService implements vscode.Disposable {
  private outputChannel: vscode.OutputChannel;
  private p4PathSetting: string | undefined; // Path to p4 executable from config
  private debugMode: boolean = false; // From config

  constructor(outputChannel: vscode.OutputChannel) {
    this.outputChannel = outputChannel;
    this.updateConfiguration();

    // Watch for configuration changes
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("perforce")) {
        this.updateConfiguration();
      }
    });
  }

  private updateConfiguration(): void {
    const config = vscode.workspace.getConfiguration("perforce");
    const commandPath = config.get<string>("command");
    this.p4PathSetting =
      commandPath && commandPath !== "none" ? commandPath : undefined;
    this.debugMode = config.get<boolean>("debugP4Commands", false);
    this.outputChannel.appendLine(
      `PerforceService config updated: p4Path=${this.p4PathSetting}, debug=${this.debugMode}`,
    );
  }

  /**
   * Executes a raw p4 command.
   * @param command The p4 command (e.g., 'edit', 'info').
   * @param args Array of arguments for the command.
   * @param options P4 environment options (P4USER, P4CLIENT, etc.) and cwd.
   * @param useTaggedOutput If true, attempts to use '-G' for tagged output.
   * @param input Standard input to pass to the p4 command (e.g., for 'p4 change -i').
   */
  public async execute(
    command: string,
    args: string[] = [],
    options: P4Options = {},
    useTaggedOutput = false,
    input?: string,
  ): Promise<P4Result> {
    this.logCommand(command, args, options, input);

    const effectiveArgs = [...args];
    let requiresPythonParsing = false;

    if (useTaggedOutput) {
      // p4 -G marshals output as Python objects. We'll need to parse this.
      effectiveArgs.unshift("-G");
      requiresPythonParsing = true;
    }

    try {
      const result = await this.spawnP4Process(
        command,
        effectiveArgs,
        options,
        useTaggedOutput,
        input,
      );

      const stdout = result.stdout ?? ""; // Assuming string for now
      const stderr = result.stderr ?? "";
      this.logOutput(stdout, stderr);

      const p4Result: P4Result = { stdout, stderr };

      if (requiresPythonParsing && stdout) {
        try {
          // Call the new parsing method
          p4Result.parsedOutput = this.parseTaggedOutput(stdout);
          if (this.debugMode) {
            this.outputChannel.appendLine(
              `Parsed Tagged Output (${command}): ${JSON.stringify(p4Result.parsedOutput, null, 2).substring(0, 1000)}...`,
            );
          }
        } catch (parseError: any) {
          this.outputChannel.appendLine(
            `Error parsing tagged output for command '${command}': ${parseError.message}`,
          );
          console.error("Tagged output parse error:", parseError);
          // Keep raw stdout, but log the error. Caller can decide how to handle.
          // Alternatively, could re-throw or add an error flag to P4Result.
        }
      }

      return p4Result;
    } catch (error: any) {
      const stderr =
        error?.stderr ??
        (error instanceof Error ? error.message : String(error));
      this.logError(command, args, stderr);
      throw new Error(`P4 command '${command}' failed: ${stderr}`);
    }
  }

  /**
   * Spawns a p4 process to run a command directly using Node.js child_process.
   * Unlike execute which uses an external library, this method directly spawns the process.
   *
   * @param command The p4 command (e.g., 'edit', 'info')
   * @param args Array of arguments for the command
   * @param options P4 environment options (P4USER, P4CLIENT, etc.) and cwd
   * @param useTaggedOutput If true, adds -G flag for tagged output
   * @param input Optional standard input to pass to the p4 command
   * @returns A promise that resolves to a P4Result object
   */
  public async spawnP4Process(
    command: string,
    args: string[] = [],
    options: P4Options = {},
    useTaggedOutput = false,
    input?: string,
  ): Promise<P4Result> {
    // Log the command being executed
    this.logCommand(command, args, options, input);

    // Copy args to avoid modifying the original array
    const effectiveArgs = [...args];
    let requiresPythonParsing = false;

    // Add -G flag for tagged output if requested
    if (useTaggedOutput) {
      effectiveArgs.unshift("-G");
      requiresPythonParsing = true;
    }

    // Determine the p4 executable path
    const p4Path = options.p4Path || this.p4PathSetting || "p4";

    // Prepare environment variables for the child process
    const env = { ...process.env }; // Start with current environment

    // Add Perforce-specific environment variables from options
    if (options.P4CLIENT) env.P4CLIENT = options.P4CLIENT;
    if (options.P4USER) env.P4USER = options.P4USER;
    if (options.P4PORT) env.P4PORT = options.P4PORT;
    if (options.P4PASSWD) env.P4PASSWD = options.P4PASSWD;
    if (options.P4CHARSET) env.P4CHARSET = options.P4CHARSET;
    if (options.P4CONFIG) env.P4CONFIG = options.P4CONFIG;

    // Full command arguments array with command as the first argument
    const fullArgs = [command, ...effectiveArgs];

    return new Promise<P4Result>((resolve, reject) => {
      try {
        // Spawn the p4 process
        const proc = childProcess.spawn(p4Path, fullArgs, {
          cwd: options.cwd,
          env: env,
          stdio: ["pipe", "pipe", "pipe"], // stdin, stdout, stderr
        });

        // Buffers to collect stdout and stderr
        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];

        // Collect stdout data
        proc.stdout.on("data", (data) => {
          stdoutChunks.push(Buffer.from(data));
        });

        // Collect stderr data
        proc.stderr.on("data", (data) => {
          stderrChunks.push(Buffer.from(data));
        });

        // Handle process exit
        proc.on("close", (code) => {
          // Convert collected buffers to strings
          const stdout = Buffer.concat(stdoutChunks).toString("utf8");
          const stderr = Buffer.concat(stderrChunks).toString("utf8");

          // Log the output
          this.logOutput(stdout, stderr);

          // Create the result object
          const p4Result: P4Result = { stdout, stderr };

          // Handle non-zero exit codes as errors
          if (code !== 0) {
            const errorMessage = `P4 command '${command}' failed with exit code ${code}`;
            this.logError(command, effectiveArgs, stderr || errorMessage);
            reject(new Error(`${errorMessage}: ${stderr}`));
            return;
          }

          // Parse tagged output if requested
          if (requiresPythonParsing && stdout) {
            try {
              p4Result.parsedOutput = this.parseTaggedOutput(stdout);
              if (this.debugMode) {
                this.outputChannel.appendLine(
                  `Parsed Tagged Output (${command}): ${JSON.stringify(p4Result.parsedOutput, null, 2).substring(0, 1000)}...`,
                );
              }
            } catch (parseError: any) {
              this.outputChannel.appendLine(
                `Error parsing tagged output for command '${command}': ${parseError.message}`,
              );
              console.error("Tagged output parse error:", parseError);
              // Continue with the raw output
            }
          }

          resolve(p4Result);
        });

        // Handle process errors
        proc.on("error", (err) => {
          const errorMessage = `Error spawning p4 process: ${err.message}`;
          this.logError(command, effectiveArgs, errorMessage);
          reject(new Error(errorMessage));
        });

        // Write to stdin if input is provided
        if (input) {
          proc.stdin.write(input);
          proc.stdin.end();
        } else {
          proc.stdin.end();
        }
      } catch (error: any) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        this.logError(command, effectiveArgs, errorMessage);
        reject(new Error(`Failed to spawn p4 process: ${errorMessage}`));
      }
    });
  }

  /**
   * Checks if the user is currently logged in to Perforce.
   * Uses `p4 login -s`.
   */
  public async checkLoginStatus(options: P4Options = {}): Promise<boolean> {
    try {
      // login -s should exit with 0 if logged in, non-zero if not/error
      // It might print different messages to stdout/stderr depending on state.
      await this.execute("login", ["-s"], options);
      // If execute doesn't throw, the exit code was 0, meaning logged in.
      this.outputChannel.appendLine("Login status check: User is logged in.");
      return true;
    } catch (error: any) {
      // Handle specific error indicating "not logged in" vs other errors
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      if (
        errorMessage.includes(
          "Perforce password (P4PASSWD) invalid or unset",
        ) ||
        errorMessage.includes("Your session has expired") ||
        errorMessage.includes("User not logged in")
      ) {
        this.outputChannel.appendLine(
          "Login status check: User is not logged in.",
        );
        return false;
      } else {
        // It might be a different error (e.g., cannot connect)
        this.outputChannel.appendLine(
          `Login status check failed with unexpected error: ${errorMessage}`,
        );
        // Re-throw unexpected errors
        throw error;
      }
    }
  }

  /**
   * Attempts to log the user into Perforce.
   * @param password Optional password to pipe to stdin.
   */
  public async login(
    options: P4Options = {},
    password?: string,
  ): Promise<void> {
    this.outputChannel.appendLine("Attempting p4 login...");
    try {
      // Execute p4 login. If a password is provided, pass it as stdin.
      const result = await this.execute("login", [], options, false, password);
      if (result.stderr && !result.stderr.includes("User logged in")) {
        // Handle cases where login command succeeds (exit 0) but might show warnings
        this.outputChannel.appendLine(`Login attempt stderr: ${result.stderr}`);
      }
      if (result.stdout.includes("User logged in")) {
        this.outputChannel.appendLine("Login successful.");
      } else {
        // Might need more specific checks based on p4 output
        this.outputChannel.appendLine(
          "Login command finished, but success message not found in stdout.",
        );
      }
    } catch (error) {
      // Error is already logged by execute method
      this.outputChannel.appendLine("Login attempt failed.");
      // Rethrow to signal failure to the caller
      throw error;
    }
  }

  /**
   * Logs the user out from Perforce.
   */
  public async logout(options: P4Options = {}): Promise<void> {
    this.outputChannel.appendLine("Attempting p4 logout...");
    try {
      await this.execute("logout", [], options);
      this.outputChannel.appendLine("Logout successful.");
    } catch (error) {
      // Error is already logged by execute method
      this.outputChannel.appendLine("Logout attempt failed.");
      // Rethrow to signal failure to the caller
      throw error;
    }
  }

  public async getInfo(options: P4Options = {}): Promise<P4Result> {
    const result = await this.execute("info", [], options, true);
    // Parsing of result.parsedOutput would happen in the caller now
    return result;
  }

  private logCommand(
    command: string,
    args: string[],
    options: P4Options,
    input?: string,
  ): void {
    if (!this.debugMode) {
      return;
    }
    const cmdLine = `p4 ${command} ${args.join(" ")}`;
    this.outputChannel.appendLine(`Executing: ${cmdLine}`);
    this.outputChannel.appendLine(`  Options: ${JSON.stringify(options)}`);
    if (input) {
      this.outputChannel.appendLine(
        `  Input: ${input.substring(0, 100)}${input.length > 100 ? "..." : ""}`,
      );
    }
    console.log(`Executing P4: ${cmdLine}`, options); // Also log to dev console if needed
  }

  private logOutput(stdout: string, stderr: string): void {
    if (!this.debugMode) {
      return;
    }
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
    this.outputChannel.appendLine(
      `ERROR running p4 ${command} ${args.join(" ")}:\n${stderr}`,
    );
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
      const buffer = Buffer.from(stdout, "latin1");

      // Use the python-marshal library to load the data
      const parsedData = marshal.load(buffer);

      // P4 -G often returns a list of dictionaries.
      return parsedData;
    } catch (error: any) {
      this.outputChannel.appendLine(`Marshal parsing failed: ${error.message}`);
      console.error(
        "Marshal parsing error:",
        error,
        "Input string (first 500 chars):",
        stdout.substring(0, 500),
      );
      throw new Error(
        `Failed to parse marshalled Python output: ${error.message}`,
      );
    }
  }

  /**
   * Uses `p4 where` to find the local filesystem path for a given depot or client path.
   * Wrapper around the p4where command function.
   * @param depotOrClientPath The depot or client path (e.g., //depot/main/file.c or //clientname/main/file.c)
   * @param options P4 options (especially cwd might be relevant)
   * @returns The absolute local filesystem path, or null if not found/mapped.
   */
  public async getLocalPath(
    depotOrClientPath: string,
    options: P4Options = {},
  ): Promise<string | null> {
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
