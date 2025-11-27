import { spawn } from "node:child_process";
import * as path from "node:path";
import { validateRequiredParams } from "./validation.js";

interface ShellArgs {
  command: string[];
  workdir?: string;
  timeout_ms?: number;
  with_escalated_permissions?: boolean;
  justification?: string;
}

interface ShellResult {
  output: string;
  stdout: string[];
  stderr: string[];
}

const DEFAULT_TIMEOUT = 120000;

/**
 * Codex-style shell tool.
 * Runs an array of shell arguments using execvp-style semantics.
 * Typically called with ["bash", "-lc", "..."] for shell commands.
 */
export async function shell(args: ShellArgs): Promise<ShellResult> {
  validateRequiredParams(args, ["command"], "shell");

  const { command, workdir, timeout_ms } = args;
  if (!Array.isArray(command) || command.length === 0) {
    throw new Error("command must be a non-empty array of strings");
  }

  const [executable, ...execArgs] = command;
  if (!executable) {
    throw new Error("command must be a non-empty array of strings");
  }
  const timeout = timeout_ms ?? DEFAULT_TIMEOUT;

  // Determine working directory
  const cwd = workdir
    ? path.isAbsolute(workdir)
      ? workdir
      : path.resolve(process.env.USER_CWD || process.cwd(), workdir)
    : process.env.USER_CWD || process.cwd();

  return new Promise((resolve, reject) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    const child = spawn(executable, execArgs, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timeoutId = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Command timed out after ${timeout}ms`));
    }, timeout);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    child.on("error", (err: Error) => {
      clearTimeout(timeoutId);
      reject(new Error(`Failed to execute command: ${err.message}`));
    });

    child.on("close", (code: number | null) => {
      clearTimeout(timeoutId);

      const stdoutText = Buffer.concat(stdoutChunks).toString("utf8");
      const stderrText = Buffer.concat(stderrChunks).toString("utf8");

      const stdoutLines = stdoutText
        .split("\n")
        .filter((line) => line.length > 0);
      const stderrLines = stderrText
        .split("\n")
        .filter((line) => line.length > 0);

      // Combine stdout and stderr for output
      const output = [stdoutText, stderrText].filter(Boolean).join("\n").trim();

      if (code !== 0 && code !== null) {
        // Command failed but we still return the output
        resolve({
          output: output || `Command exited with code ${code}`,
          stdout: stdoutLines,
          stderr: stderrLines,
        });
      } else {
        resolve({
          output,
          stdout: stdoutLines,
          stderr: stderrLines,
        });
      }
    });
  });
}
