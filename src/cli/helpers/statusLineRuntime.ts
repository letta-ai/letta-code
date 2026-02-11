// src/cli/helpers/statusLineRuntime.ts
// Executes a status-line shell command, pipes JSON to stdin, collects stdout.

import { type ChildProcess, spawn } from "node:child_process";
import { buildShellLaunchers } from "../../tools/impl/shellLaunchers";

/** Maximum stdout bytes collected (4 KB). */
const MAX_STDOUT_BYTES = 4096;

/** Result returned by executeStatusLineCommand. */
export interface StatusLineResult {
  text: string;
  ok: boolean;
  durationMs: number;
  error?: string;
}

/**
 * Execute a status-line command.
 *
 * Spawns the command via platform-appropriate shell launchers (same strategy
 * as hook execution), pipes `payload` as JSON to stdin, and collects up to
 * MAX_STDOUT_BYTES of stdout.
 */
export async function executeStatusLineCommand(
  command: string,
  payload: unknown,
  options: {
    timeout: number;
    signal?: AbortSignal;
    workingDirectory?: string;
  },
): Promise<StatusLineResult> {
  const startTime = Date.now();
  const { timeout, signal, workingDirectory } = options;

  // Early abort check
  if (signal?.aborted) {
    return { text: "", ok: false, durationMs: 0, error: "Aborted" };
  }

  const launchers = buildShellLaunchers(command);
  if (launchers.length === 0) {
    return {
      text: "",
      ok: false,
      durationMs: Date.now() - startTime,
      error: "No shell launchers available",
    };
  }

  const inputJson = JSON.stringify(payload);
  let lastError: string | null = null;

  for (const launcher of launchers) {
    try {
      const result = await runWithLauncher(
        launcher,
        inputJson,
        timeout,
        signal,
        workingDirectory,
        startTime,
      );
      return result;
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        lastError = error.message;
        continue;
      }
      return {
        text: "",
        ok: false,
        durationMs: Date.now() - startTime,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return {
    text: "",
    ok: false,
    durationMs: Date.now() - startTime,
    error: lastError ?? "No suitable shell found",
  };
}

function runWithLauncher(
  launcher: string[],
  inputJson: string,
  timeout: number,
  signal: AbortSignal | undefined,
  workingDirectory: string | undefined,
  startTime: number,
): Promise<StatusLineResult> {
  return new Promise<StatusLineResult>((resolve, reject) => {
    const [executable, ...args] = launcher;
    if (!executable) {
      reject(new Error("Empty launcher"));
      return;
    }

    let stdout = "";
    let stdoutBytes = 0;
    let timedOut = false;
    let resolved = false;

    const safeResolve = (result: StatusLineResult) => {
      if (!resolved) {
        resolved = true;
        resolve(result);
      }
    };

    let child: ChildProcess;
    try {
      child = spawn(executable, args, {
        cwd: workingDirectory || process.cwd(),
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      reject(error);
      return;
    }

    // Timeout
    const timeoutId = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!resolved) child.kill("SIGKILL");
      }, 500);
    }, timeout);

    // AbortSignal
    const onAbort = () => {
      if (!resolved) {
        child.kill("SIGTERM");
        clearTimeout(timeoutId);
        safeResolve({
          text: "",
          ok: false,
          durationMs: Date.now() - startTime,
          error: "Aborted",
        });
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    // Stdin
    if (child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.write(inputJson);
      child.stdin.end();
    }

    // Stdout (capped)
    if (child.stdout) {
      child.stdout.on("data", (data: Buffer) => {
        if (stdoutBytes < MAX_STDOUT_BYTES) {
          const remaining = MAX_STDOUT_BYTES - stdoutBytes;
          const chunk = data.toString(
            "utf-8",
            0,
            Math.min(data.length, remaining),
          );
          stdout += chunk;
          stdoutBytes += data.length;
        }
      });
    }

    // Stderr (ignored for status line)

    child.on("close", (code: number | null) => {
      clearTimeout(timeoutId);
      signal?.removeEventListener("abort", onAbort);
      const durationMs = Date.now() - startTime;

      if (timedOut) {
        safeResolve({
          text: "",
          ok: false,
          durationMs,
          error: `Status line command timed out after ${timeout}ms`,
        });
        return;
      }

      const ok = code === 0;
      safeResolve({
        text: ok ? stdout.trim() : "",
        ok,
        durationMs,
        ...(!ok && { error: `Exit code ${code ?? "null"}` }),
      });
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timeoutId);
      signal?.removeEventListener("abort", onAbort);

      if (error.code === "ENOENT") {
        reject(error);
        return;
      }

      safeResolve({
        text: "",
        ok: false,
        durationMs: Date.now() - startTime,
        error: error.message,
      });
    });
  });
}
