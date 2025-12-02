import { spawn } from "node:child_process";
import * as path from "node:path";
import { getShellEnv } from "./shellEnv.js";
import { buildShellLaunchers } from "./shellLaunchers.js";
import { validateRequiredParams } from "./validation.js";

export class ShellExecutionError extends Error {
  code?: string;
  executable?: string;
}

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

type SpawnContext = {
  command: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeout: number;
};

function runProcess(context: SpawnContext): Promise<ShellResult> {
  return new Promise((resolve, reject) => {
    const { command, cwd, env, timeout } = context;
    const [executable, ...execArgs] = command;
    if (!executable) {
      reject(new ShellExecutionError("Executable is required"));
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    const child = spawn(executable, execArgs, {
      cwd,
      env,
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

    child.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timeoutId);
      const execError = new ShellExecutionError(
        err?.code === "ENOENT"
          ? `Executable not found: ${executable}`
          : `Failed to execute command: ${err?.message || "unknown error"}`,
      );
      execError.code = err?.code;
      execError.executable = executable;
      reject(execError);
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

      const output = [stdoutText, stderrText].filter(Boolean).join("\n").trim();

      if (code !== 0 && code !== null) {
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

  const timeout = timeout_ms ?? DEFAULT_TIMEOUT;
  const cwd = workdir
    ? path.isAbsolute(workdir)
      ? workdir
      : path.resolve(process.env.USER_CWD || process.cwd(), workdir)
    : process.env.USER_CWD || process.cwd();

  const context: SpawnContext = {
    command,
    cwd,
    env: getShellEnv(),
    timeout,
  };

  try {
    return await runProcess(context);
  } catch (error) {
    if (error instanceof ShellExecutionError && error.code === "ENOENT") {
      for (const fallback of buildFallbackCommands(command)) {
        try {
          return await runProcess({ ...context, command: fallback });
        } catch (retryError) {
          if (
            retryError instanceof ShellExecutionError &&
            retryError.code === "ENOENT"
          ) {
            continue;
          }
          throw retryError;
        }
      }
    }
    throw error;
  }
}

function buildFallbackCommands(command: string[]): string[][] {
  if (!command.length) return [];
  const first = command[0];
  if (!first) return [];
  if (!isShellExecutableName(first)) return [];
  const script = extractShellScript(command);
  if (!script) return [];
  const launchers = buildShellLaunchers(script);
  return launchers.filter((launcher) => !arraysEqual(launcher, command));
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function isShellExecutableName(name: string): boolean {
  const normalized = name.replace(/\\/g, "/").toLowerCase();
  if (/(^|\/)(ba|z|a|da)?sh$/.test(normalized)) {
    return true;
  }
  if (normalized.endsWith("cmd.exe")) {
    return true;
  }
  if (normalized.includes("powershell")) {
    return true;
  }
  if (normalized.includes("pwsh")) {
    return true;
  }
  return false;
}

function extractShellScript(command: string[]): string | null {
  for (let i = 1; i < command.length; i += 1) {
    const token = command[i];
    if (!token) continue;
    const normalized = token.toLowerCase();
    if (
      normalized === "-c" ||
      normalized === "-lc" ||
      normalized === "/c" ||
      ((normalized.startsWith("-") || normalized.startsWith("/")) &&
        normalized.endsWith("c"))
    ) {
      return command[i + 1] ?? null;
    }
  }
  return null;
}
