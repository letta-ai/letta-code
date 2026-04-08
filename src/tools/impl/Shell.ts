import { existsSync, statSync } from "node:fs";
import * as path from "node:path";
import { getShellEnv } from "./shellEnv.js";
import { buildShellLaunchers } from "./shellLaunchers.js";
import { ShellExecutionError, spawnWithLauncher } from "./shellRunner.js";
import { validateRequiredParams } from "./validation.js";

interface ShellArgs {
  command: string[];
  workdir?: string;
  timeout_ms?: number;
  env_overrides?: NodeJS.ProcessEnv;
  with_escalated_permissions?: boolean;
  justification?: string;
  signal?: AbortSignal;
  onOutput?: (chunk: string, stream: "stdout" | "stderr") => void;
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
  signal?: AbortSignal;
  onOutput?: (chunk: string, stream: "stdout" | "stderr") => void;
};

async function runProcess(context: SpawnContext): Promise<ShellResult> {
  const { stdout, stderr, exitCode } = await spawnWithLauncher(
    context.command,
    {
      cwd: context.cwd,
      env: context.env,
      timeoutMs: context.timeout,
      signal: context.signal,
      onOutput: context.onOutput,
    },
  );

  const stdoutLines = stdout.split("\n").filter((line) => line.length > 0);
  const stderrLines = stderr.split("\n").filter((line) => line.length > 0);
  const output = [stdout, stderr].filter(Boolean).join("\n").trim();

  if (exitCode !== 0 && exitCode !== null) {
    return {
      output: output || `Command exited with code ${exitCode}`,
      stdout: stdoutLines,
      stderr: stderrLines,
    };
  }

  return {
    output,
    stdout: stdoutLines,
    stderr: stderrLines,
  };
}

/**
 * Codex-style shell tool.
 * Runs an array of shell arguments using execvp-style semantics.
 * Typically called with ["bash", "-lc", "..."] for shell commands.
 */
export async function shell(args: ShellArgs): Promise<ShellResult> {
  validateRequiredParams(args, ["command"], "shell");

  const { command, workdir, timeout_ms, env_overrides, signal, onOutput } =
    args;
  if (!Array.isArray(command) || command.length === 0) {
    throw new Error("command must be a non-empty array of strings");
  }

  const timeout = timeout_ms ?? DEFAULT_TIMEOUT;
  const defaultCwd = process.env.USER_CWD || process.cwd();
  const requestedCwd = workdir
    ? path.isAbsolute(workdir)
      ? workdir
      : path.resolve(defaultCwd, workdir)
    : defaultCwd;
  const cwd = isUsableDirectory(requestedCwd) ? requestedCwd : defaultCwd;

  const context: SpawnContext = {
    command,
    cwd,
    env: {
      ...getShellEnv(),
      ...(env_overrides ?? {}),
    },
    timeout,
    signal,
    onOutput,
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
  const shellIndex = findShellExecutableIndex(command);
  if (shellIndex === null) return [];
  const script = extractShellScript(command, shellIndex);
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

function isUsableDirectory(candidate: string): boolean {
  try {
    return existsSync(candidate) && statSync(candidate).isDirectory();
  } catch {
    return false;
  }
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

function isEnvExecutableName(name: string): boolean {
  const normalized = name.replace(/\\/g, "/").toLowerCase();
  return normalized === "env" || normalized.endsWith("/env");
}

function findShellExecutableIndex(command: string[]): number | null {
  const first = command[0];
  if (!first) return null;
  if (isShellExecutableName(first)) return 0;
  if (!isEnvExecutableName(first)) return null;

  for (let i = 1; i < command.length; i += 1) {
    const token = command[i];
    if (!token) continue;
    if (token.startsWith("-")) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token)) continue;
    return isShellExecutableName(token) ? i : null;
  }

  return null;
}

function extractShellScript(
  command: string[],
  shellIndex: number,
): string | null {
  for (let i = shellIndex + 1; i < command.length; i += 1) {
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
