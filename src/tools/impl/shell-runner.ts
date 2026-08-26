import { type ChildProcess, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { isUsableDirectory } from "@/helpers/usable-directory";
import { noteExpectedWorktreeForLauncher } from "@/websocket/listener/worktree-ownership";
import {
  createGitHubPullRequestOutputTracker,
  type ShellSourceCommand,
} from "./github-pull-request-tracker.js";

export class ShellExecutionError extends Error {
  code?: string;
  executable?: string;
  cwd?: string;
  /** Distinguishes which lookup failed when `code` is ENOENT. */
  reason?: "executable_missing" | "cwd_missing";
}

export type ShellOutputStream = "stdout" | "stderr";

export type ShellSpawnOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** Command before launcher and sandbox wrapping, used for completion metadata. */
  sourceCommand?: ShellSourceCommand;
  signal?: AbortSignal;
  onOutput?: (chunk: string, stream: ShellOutputStream) => void;
  tty?: boolean;
  /** Disable when the caller already keeps its own bounded output buffer. */
  captureOutput?: boolean;
};

export interface ShellProcessHandle {
  kill(signal?: string | number): unknown;
  interrupt(): void;
  write(input: string): void;
}

export interface ShellProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export interface RunningShellProcess {
  process: ShellProcessHandle;
  completion: Promise<ShellProcessResult>;
  terminate(): void;
}

type NodePtyExitEvent = { exitCode?: number; signal?: number };

type NodePtyProcess = {
  pid: number;
  write: (data: string) => void;
  kill: (signal?: string) => void;
  onData: (listener: (data: string) => void) => void;
  onExit: (listener: (event: NodePtyExitEvent) => void) => void;
};

type NodePtyModule = {
  spawn: (
    file: string,
    args: string[],
    options: {
      name: string;
      cols: number;
      rows: number;
      cwd: string;
      env: Record<string, string>;
    },
  ) => NodePtyProcess;
};

type ProcessEvents = {
  output(data: Buffer | string, stream: ShellOutputStream): void;
  error(error: NodeJS.ErrnoException): void;
  close(code: number | null): void;
};

const NODE_PTY_BRIDGE_SCRIPT = `
const pty = require("node-pty");
const config = JSON.parse(process.argv[1]);
const child = pty.spawn(config.executable, config.args, {
  name: "xterm-256color",
  cols: 80,
  rows: 24,
  cwd: config.cwd,
  env: process.env,
});
child.onData((data) => process.stdout.write(data));
child.onExit(({ exitCode }) => process.exit(typeof exitCode === "number" ? exitCode : 1));
process.stdin.setEncoding("utf8");
process.stdin.on("data", (data) => child.write(data));
process.on("SIGTERM", () => child.kill("SIGTERM"));
process.on("SIGINT", () => child.kill("SIGINT"));
`;

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

function buildTimeoutError(
  stdout: string,
  stderr: string,
  code: number | null,
): Error {
  return Object.assign(new Error("Command timed out"), {
    killed: true,
    signal: "SIGTERM",
    stdout,
    stderr,
    code,
  });
}

function buildAbortError(stdout: string, stderr: string): Error {
  return Object.assign(new Error("The operation was aborted"), {
    name: "AbortError",
    code: "ABORT_ERR",
    stdout,
    stderr,
  });
}

function buildPtyEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const ptyEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      ptyEnv[key] = value;
    }
  }
  ptyEnv.TERM = ptyEnv.TERM || "xterm-256color";
  ptyEnv.COLORTERM = ptyEnv.COLORTERM || "truecolor";
  return ptyEnv;
}

function killChildProcessTree(
  childProcess: ChildProcess,
  signal: string | number = "SIGTERM",
): void {
  if (!childProcess.pid) {
    return;
  }

  if (process.platform === "win32") {
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
    process.kill(-childProcess.pid, signal as NodeJS.Signals);
  } catch {
    try {
      childProcess.kill(signal as NodeJS.Signals);
    } catch {
      // Already dead, ignore.
    }
  }
}

function interruptChildProcessTree(childProcess: ChildProcess): void {
  if (process.platform === "win32") {
    throw new ShellExecutionError(
      "Process interrupt is not supported on Windows",
    );
  }
  killChildProcessTree(childProcess, "SIGINT");
}

function spawnPipeProcess(
  launcher: string[],
  options: ShellSpawnOptions,
  events: ProcessEvents,
): ShellProcessHandle {
  const [executable, ...args] = launcher;
  if (!executable) {
    throw new ShellExecutionError("Executable is required");
  }

  const childProcess: ChildProcess = spawn(executable, args, {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });

  childProcess.stdout?.on("data", (chunk: Buffer) => {
    events.output(chunk, "stdout");
  });
  childProcess.stderr?.on("data", (chunk: Buffer) => {
    events.output(chunk, "stderr");
  });
  childProcess.on("error", events.error);
  childProcess.on("close", events.close);

  return {
    kill(signal?: string | number) {
      killChildProcessTree(childProcess, signal);
    },
    interrupt() {
      interruptChildProcessTree(childProcess);
    },
    write(_input: string) {
      // Pipe-mode shell processes deliberately keep stdin closed.
    },
  };
}

function spawnPtyBridgeProcess(
  launcher: string[],
  options: ShellSpawnOptions,
  events: ProcessEvents,
): ShellProcessHandle {
  const [executable, ...args] = launcher;
  if (!executable) {
    throw new ShellExecutionError("Executable is required");
  }

  const childProcess: ChildProcess = spawn(
    "node",
    [
      "-e",
      NODE_PTY_BRIDGE_SCRIPT,
      JSON.stringify({ executable, args, cwd: options.cwd }),
    ],
    {
      cwd: options.cwd,
      env: buildPtyEnv(options.env),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    },
  );

  childProcess.stdout?.on("data", (chunk: Buffer) => {
    events.output(chunk, "stdout");
  });
  childProcess.stderr?.on("data", (chunk: Buffer) => {
    events.output(chunk, "stderr");
  });
  childProcess.on("error", events.error);
  childProcess.on("close", events.close);

  return {
    kill(signal?: string | number) {
      killChildProcessTree(childProcess, signal);
    },
    interrupt() {
      interruptChildProcessTree(childProcess);
    },
    write(input: string) {
      childProcess.stdin?.write(input);
    },
  };
}

function spawnNativePtyProcess(
  launcher: string[],
  options: ShellSpawnOptions,
  events: ProcessEvents,
): ShellProcessHandle {
  const [executable, ...args] = launcher;
  if (!executable) {
    throw new ShellExecutionError("Executable is required");
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pty = require("node-pty") as NodePtyModule;
  const ptyProcess = pty.spawn(executable, args, {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd: options.cwd,
    env: buildPtyEnv(options.env),
  });

  ptyProcess.onData((data) => events.output(data, "stdout"));
  ptyProcess.onExit(({ exitCode }) => {
    events.close(typeof exitCode === "number" ? exitCode : null);
  });

  return {
    kill(signal?: string | number) {
      ptyProcess.kill(typeof signal === "string" ? signal : undefined);
    },
    interrupt() {
      ptyProcess.kill("SIGINT");
    },
    write(input: string) {
      ptyProcess.write(input);
    },
  };
}

function spawnPtyProcess(
  launcher: string[],
  options: ShellSpawnOptions,
  events: ProcessEvents,
): ShellProcessHandle {
  // node-pty's native handles do not integrate reliably when loaded into
  // Bun's event loop. Local Bun dev/tests use a tiny Node bridge; the
  // distributed CLI runs under Node and uses node-pty directly.
  return typeof Bun !== "undefined"
    ? spawnPtyBridgeProcess(launcher, options, events)
    : spawnNativePtyProcess(launcher, options, events);
}

/**
 * Starts one shell process. Every built-in shell surface uses this function,
 * while its adapter decides whether to await completion or expose a session.
 */
export function startShellProcess(
  launcher: string[],
  options: ShellSpawnOptions,
): RunningShellProcess {
  const [executable] = launcher;
  if (!executable) {
    throw new ShellExecutionError("Executable is required");
  }
  if (!isUsableDirectory(options.cwd)) {
    throw buildSpawnError(
      { code: "ENOENT" } as NodeJS.ErrnoException,
      executable,
      options.cwd,
    );
  }

  noteExpectedWorktreeForLauncher(launcher, options.cwd);

  const pullRequestTracker = createGitHubPullRequestOutputTracker(
    options.sourceCommand ?? launcher,
  );

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const outputDecoders = {
    stdout: new StringDecoder("utf8"),
    stderr: new StringDecoder("utf8"),
  };
  let completed = false;
  let timedOut = false;
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveCompletion!: (result: ShellProcessResult) => void;
  let rejectCompletion!: (error: Error) => void;
  const completion = new Promise<ShellProcessResult>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });

  const cleanup = () => {
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
      timeoutTimer = undefined;
    }
    if (forceKillTimer) {
      clearTimeout(forceKillTimer);
      forceKillTimer = undefined;
    }
    options.signal?.removeEventListener("abort", abortHandler);
  };

  let processHandle: ShellProcessHandle;
  const terminateProcess = () => {
    if (process.platform === "win32") {
      processHandle.kill("SIGKILL");
      return;
    }

    processHandle.kill("SIGTERM");
    if (!forceKillTimer) {
      forceKillTimer = setTimeout(() => {
        if (!completed) {
          processHandle.kill("SIGKILL");
        }
      }, FORCE_KILL_GRACE_MS);
    }
  };

  const abortHandler = () => {
    terminateProcess();
  };

  const emitDecodedOutput = (text: string, stream: ShellOutputStream): void => {
    if (!text) return;
    pullRequestTracker?.append(text, stream);
    options.onOutput?.(text, stream);
  };

  const flushOutputDecoders = (): void => {
    emitDecodedOutput(outputDecoders.stdout.end(), "stdout");
    emitDecodedOutput(outputDecoders.stderr.end(), "stderr");
  };

  const events: ProcessEvents = {
    output(data, stream) {
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (options.captureOutput !== false) {
        if (stream === "stdout") {
          stdoutChunks.push(buffer);
        } else {
          stderrChunks.push(buffer);
        }
      }
      emitDecodedOutput(outputDecoders[stream].write(buffer), stream);
    },
    error(error) {
      if (completed) return;
      completed = true;
      cleanup();
      flushOutputDecoders();
      void pullRequestTracker?.finish();
      rejectCompletion(buildSpawnError(error, executable, options.cwd));
    },
    close(code) {
      if (completed) return;
      completed = true;
      cleanup();
      flushOutputDecoders();
      void pullRequestTracker?.finish();
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (timedOut) {
        rejectCompletion(buildTimeoutError(stdout, stderr, code));
        return;
      }
      if (options.signal?.aborted) {
        rejectCompletion(buildAbortError(stdout, stderr));
        return;
      }
      resolveCompletion({ stdout, stderr, exitCode: code });
    },
  };

  try {
    processHandle = options.tty
      ? spawnPtyProcess(launcher, options, events)
      : spawnPipeProcess(launcher, options, events);
  } catch (error) {
    completed = true;
    cleanup();
    const failure = error instanceof Error ? error : new Error(String(error));
    rejectCompletion(failure);
    // Preserve synchronous startup errors without leaving the deferred
    // completion promise unhandled.
    void completion.catch(() => {});
    throw failure;
  }

  if (options.timeoutMs) {
    timeoutTimer = setTimeout(() => {
      if (completed) return;
      timedOut = true;
      terminateProcess();
    }, options.timeoutMs);
  }
  options.signal?.addEventListener("abort", abortHandler, { once: true });
  if (options.signal?.aborted) {
    abortHandler();
  }

  return { process: processHandle, completion, terminate: terminateProcess };
}

/**
 * Compatibility helper for callers that wait for the process to finish.
 */
export async function spawnWithLauncher(
  launcher: string[],
  options: ShellSpawnOptions,
): Promise<ShellProcessResult> {
  return startShellProcess(launcher, options).completion;
}
