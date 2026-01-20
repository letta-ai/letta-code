/**
 * Persistent shell for bash mode.
 * Spawns an interactive shell once and reuses it for multiple commands.
 * This allows user aliases and functions from ~/.zshrc to work.
 */

import { spawn, type ChildProcess } from "child_process";
import { getShellEnv } from "../../tools/impl/shellEnv.js";

// Unique marker to detect command completion
const MARKER_PREFIX = "__LETTA_CMD_DONE_";

export class PersistentShell {
  private shell: ChildProcess | null = null;
  private outputBuffer = "";
  private pendingResolve: ((output: string) => void) | null = null;
  private currentMarker: string | null = null;
  private isReady = false;
  private readyPromise: Promise<void>;
  private readyResolve: (() => void) | null = null;

  constructor() {
    this.readyPromise = new Promise((resolve) => {
      this.readyResolve = resolve;
    });
    this.spawn();
  }

  private spawn() {
    // Determine shell - prefer user's shell, fallback to zsh on macOS
    const userShell = process.env.SHELL || "/bin/zsh";
    const shell = process.platform === "darwin" ? "/bin/zsh" : userShell;

    this.shell = spawn(shell, ["-i"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...getShellEnv(),
        // Set TERM to support some color output
        TERM: "xterm-256color",
        // Disable some interactive features that might cause issues
        HISTFILE: "",
      },
      cwd: process.cwd(),
    });

    // Handle stdout
    this.shell.stdout?.on("data", (data: Buffer) => {
      this.handleOutput(data.toString());
    });

    // Handle stderr (merge with stdout for display)
    this.shell.stderr?.on("data", (data: Buffer) => {
      this.handleOutput(data.toString());
    });

    // Handle shell exit
    this.shell.on("exit", (code) => {
      console.error(`[PersistentShell] Shell exited with code ${code}`);
      this.shell = null;
      this.isReady = false;
    });

    this.shell.on("error", (err) => {
      console.error(`[PersistentShell] Shell error:`, err);
      this.shell = null;
      this.isReady = false;
    });

    // Wait a bit for shell to initialize, then mark as ready
    // We send a simple command to ensure the shell is responsive
    setTimeout(() => {
      if (this.shell?.stdin) {
        const initMarker = `${MARKER_PREFIX}INIT_${Date.now()}__`;
        this.currentMarker = initMarker;
        this.shell.stdin.write(`echo "${initMarker}"\n`);
      }
    }, 100);
  }

  private handleOutput(data: string) {
    this.outputBuffer += data;

    // Check for init marker (shell is ready)
    if (!this.isReady && this.currentMarker && this.outputBuffer.includes(this.currentMarker)) {
      this.isReady = true;
      this.outputBuffer = "";
      this.currentMarker = null;
      this.readyResolve?.();
      return;
    }

    // Check for command completion marker
    if (this.currentMarker && this.outputBuffer.includes(this.currentMarker)) {
      const parts = this.outputBuffer.split(this.currentMarker);
      const output = parts[0] || "";
      
      // Clean up the output - remove the echo command itself if visible
      const cleanOutput = this.cleanOutput(output);
      
      if (this.pendingResolve) {
        this.pendingResolve(cleanOutput);
        this.pendingResolve = null;
      }
      
      // Keep any output after the marker for next command
      this.outputBuffer = parts.slice(1).join(this.currentMarker);
      this.currentMarker = null;
    }
  }

  private cleanOutput(output: string): string {
    // Remove leading/trailing whitespace and empty lines
    let lines = output.split("\n");
    
    // Remove empty lines at start and end
    while (lines.length > 0 && lines[0].trim() === "") {
      lines.shift();
    }
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
      lines.pop();
    }
    
    return lines.join("\n");
  }

  /**
   * Wait for shell to be ready
   */
  async waitReady(): Promise<void> {
    return this.readyPromise;
  }

  /**
   * Run a command in the persistent shell
   */
  async runCommand(command: string, timeoutMs = 30000): Promise<string> {
    if (!this.shell || !this.shell.stdin) {
      throw new Error("Shell is not running");
    }

    await this.waitReady();

    return new Promise((resolve, reject) => {
      const marker = `${MARKER_PREFIX}${Date.now()}_${Math.random().toString(36).slice(2)}__`;
      this.currentMarker = marker;
      this.outputBuffer = "";
      this.pendingResolve = resolve;

      // Set up timeout
      const timeout = setTimeout(() => {
        if (this.pendingResolve === resolve) {
          this.pendingResolve = null;
          this.currentMarker = null;
          reject(new Error(`Command timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      // Override resolve to clear timeout
      this.pendingResolve = (output: string) => {
        clearTimeout(timeout);
        resolve(output);
      };

      // Send command followed by marker echo
      // Use ; to ensure marker runs even if command fails
      this.shell!.stdin!.write(`${command}; echo "${marker}"\n`);
    });
  }

  /**
   * Check if shell is alive and ready
   */
  isAlive(): boolean {
    return this.shell !== null && this.isReady;
  }

  /**
   * Kill the shell
   */
  kill(): void {
    if (this.shell) {
      this.shell.kill("SIGTERM");
      this.shell = null;
      this.isReady = false;
    }
  }
}

// Singleton instance for bash mode
let bashModeShell: PersistentShell | null = null;

/**
 * Get or create the bash mode shell
 */
export function getBashModeShell(): PersistentShell {
  if (!bashModeShell || !bashModeShell.isAlive()) {
    bashModeShell = new PersistentShell();
  }
  return bashModeShell;
}

/**
 * Kill the bash mode shell (call when exiting bash mode)
 */
export function killBashModeShell(): void {
  if (bashModeShell) {
    bashModeShell.kill();
    bashModeShell = null;
  }
}
