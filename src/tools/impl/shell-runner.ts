import { spawn } from "node:child_process";
import { isUsableDirectory } from "@/helpers/usable-directory";
import { noteExpectedWorktreeForLauncher } from "@/websocket/listener/worktree-ownership";

export class ShellExecutionError extends Error {
  code?: string;
  executable?: string;
  cwd?: string;
  /** Distinguishes which lookup failed when `code` is ENOENT. */
  reason?: "executable_missing" | "cwd_missing";
}

export type ShellSpawnOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
  onOutput?: (chunk: string, stream: "stdout" | "stderr") => void;
};

const FORCE_KILL_GRACE_MS = 2000;

function buildSpawnError(
  err: NodeJS.ErrnoException,
  executable: string,
  cwd: string,
): ShellExecutionError {
  let message = `Failed to execute command: ${err?.message || "unknown error"}`;
  let reason: ShellExecutionError["reason"];
  if (err?.code === "ENOENT") {
    if (isUsableDirectory(cwd)) {
      message = `Executable not found: ${executable}`;
      reason = "executable_missing";
    } else {
      message = `Working directory not found: ${cwd}`;
      reason = "cwd_missing";
    }
  }

  const execError = new ShellExecutionError(message);
  execError.code = err?.code;
  execError.executable = executable;
  execError.cwd = cwd;
  execError.reason = reason;
  return execError;
}

/**
 * Spawn a command with a specific launcher.
 * Returns a promise that resolves with the output or rejects with an error.
 */
export function spawnWithLauncher(
  launcher: string[],
  options: ShellSpawnOptions,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const [executable, ...args] = launcher;
    if (!executable) {
      reject(new ShellExecutionError("Executable is required"));
      return;
    }

    if (!isUsableDirectory(options.cwd)) {
      reject(
        buildSpawnError(
          { code: "ENOENT" } as NodeJS.ErrnoException,
          executable,
          options.cwd,
        ),
      );
      return;
    }

    noteExpectedWorktreeForLauncher(launcher, options.cwd);

    const childProcess = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      // On Unix, detached creates a new process group for clean termination
      // On Windows, detached creates a new console window which we don't want
      detached: process.platform !== "win32",
    });

    // Helper to kill the entire process tree.
    const killProcessTree = (signal: "SIGTERM" | "SIGKILL") => {
      if (childProcess.pid) {
        if (process.platform === "win32") {
          // Windows has no Unix-style process groups or graceful SIGTERM.
          // taskkill is required so descendants cannot keep stdio open after
          // the launcher exits.
          const taskkill = spawn(
            "taskkill.exe",
            ["/pid", String(childProcess.pid), "/t", "/f"],
            {
              stdio: "ignore",
              windowsHide: true,
            },
          );
          taskkill.once("error", () => {
            try {
              childProcess.kill("SIGKILL");
            } catch {
              // Already dead, ignore.
            }
          });
          taskkill.once("close", (code) => {
            if (code === 0) return;
            try {
              childProcess.kill("SIGKILL");
            } catch {
              // Already dead, ignore.
            }
          });
          return;
        }

        try {
          // Unix: kill the process group using negative PID.
          process.kill(-childProcess.pid, signal);
        } catch {
          // Process may already be dead, try killing just the child
          try {
            childProcess.kill(signal);
          } catch {
            // Already dead, ignore
          }
        }
      }
    };

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    let completed = false;

    const terminateProcess = () => {
      if (process.platform === "win32") {
        killProcessTree("SIGKILL");
        return;
      }

      killProcessTree("SIGTERM");
      if (!killTimer) {
        killTimer = setTimeout(() => {
          if (!completed) {
            killProcessTree("SIGKILL");
          }
        }, FORCE_KILL_GRACE_MS);
      }
    };

    // Only set timeout if timeoutMs > 0 (0 means no timeout)
    const timeoutId = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          terminateProcess();
        }, options.timeoutMs)
      : null;

    const abortHandler = () => {
      terminateProcess();
    };
    if (options.signal) {
      options.signal.addEventListener("abort", abortHandler, { once: true });
    }

    childProcess.stdout?.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
      options.onOutput?.(chunk.toString("utf8"), "stdout");
    });

    childProcess.stderr?.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
      options.onOutput?.(chunk.toString("utf8"), "stderr");
    });

    childProcess.on("error", (err: NodeJS.ErrnoException) => {
      completed = true;
      if (timeoutId) clearTimeout(timeoutId);
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
      if (options.signal) {
        options.signal.removeEventListener("abort", abortHandler);
      }

      reject(buildSpawnError(err, executable, options.cwd));
    });

    childProcess.on("close", (code) => {
      completed = true;
      if (timeoutId) clearTimeout(timeoutId);
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
      if (options.signal) {
        options.signal.removeEventListener("abort", abortHandler);
      }

      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");

      if (timedOut) {
        reject(
          Object.assign(new Error("Command timed out"), {
            killed: true,
            signal: "SIGTERM",
            stdout,
            stderr,
            code,
          }),
        );
        return;
      }

      if (options.signal?.aborted) {
        reject(
          Object.assign(new Error("The operation was aborted"), {
            name: "AbortError",
            code: "ABORT_ERR",
            stdout,
            stderr,
          }),
        );
        return;
      }

      resolve({ stdout, stderr, exitCode: code });
    });
  });
}
