import { type ChildProcess, spawn } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";

export const HOST_EVENT_PREFIX = "LETTA_HOST_EVENT ";
const HOST_SHUTDOWN_COMMAND =
  'LETTA_HOST_COMMAND {"version":1,"type":"shutdown"}\n';

export type DaemonStatusKind =
  | "stopped"
  | "starting"
  | "connected"
  | "working"
  | "reconnecting"
  | "error";

export interface DaemonStatus {
  detail?: string;
  kind: DaemonStatusKind;
}

export type HostEvent =
  | {
      connectionId: string;
      type: "ready";
      version: 1;
    }
  | {
      connectionId: string;
      type: "processing";
      version: 1;
    }
  | {
      attempt: number;
      connectionId: string;
      retryInMs: number;
      type: "reconnecting";
      version: 1;
    }
  | {
      message: string;
      reason: string;
      type: "fatal";
      version: 1;
    };

interface ListenerSupervisorOptions {
  cliPath: string;
  environmentName: string;
  executablePath: string;
  logPath: string;
  modulePath: string;
  onStatus(status: DaemonStatus): void;
}

// The listener can spend up to five seconds draining detached work and has a
// ten-second final cleanup watchdog. Wait beyond that before killing its tree.
const GRACEFUL_STOP_MS = 12_000;
const MAX_RESTART_DELAY_MS = 30_000;
const FINAL_STOP_WAIT_MS = 2_000;
export const RESTART_STABILITY_WINDOW_MS = 60_000;

export function wasListenerStable(
  readyAt: number | null,
  exitedAt: number,
): boolean {
  return readyAt !== null && exitedAt - readyAt >= RESTART_STABILITY_WINDOW_MS;
}

export function parseHostEventLine(line: string): HostEvent | null {
  if (!line.startsWith(HOST_EVENT_PREFIX)) return null;
  try {
    const value = JSON.parse(line.slice(HOST_EVENT_PREFIX.length)) as unknown;
    if (!value || typeof value !== "object") return null;
    const event = value as Record<string, unknown>;
    if (event.version !== 1 || typeof event.type !== "string") return null;

    if (event.type === "ready" || event.type === "processing") {
      return isNonEmptyString(event.connectionId)
        ? {
            version: 1,
            type: event.type,
            connectionId: event.connectionId,
          }
        : null;
    }
    if (event.type === "reconnecting") {
      return isNonEmptyString(event.connectionId) &&
        isPositiveInteger(event.attempt) &&
        isNonNegativeFiniteNumber(event.retryInMs)
        ? {
            version: 1,
            type: "reconnecting",
            connectionId: event.connectionId,
            attempt: event.attempt,
            retryInMs: event.retryInMs,
          }
        : null;
    }
    if (event.type === "fatal") {
      return isNonEmptyString(event.reason) && isNonEmptyString(event.message)
        ? {
            version: 1,
            type: "fatal",
            reason: event.reason,
            message: event.message,
          }
        : null;
    }
    return null;
  } catch {
    return null;
  }
}

export class ListenerSupervisor {
  readonly #cliPath: string;
  readonly #executablePath: string;
  readonly #expectedExits = new WeakSet<ChildProcess>();
  readonly #logPath: string;
  readonly #modulePath: string;
  readonly #onStatus: (status: DaemonStatus) => void;
  #child: ChildProcess | null = null;
  #desiredRunning = false;
  #environmentName: string;
  #lifecycle: Promise<void> = Promise.resolve();
  #readyAt: number | null = null;
  #restartAttempts = 0;
  #restartTimer: NodeJS.Timeout | null = null;

  constructor(options: ListenerSupervisorOptions) {
    this.#cliPath = options.cliPath;
    this.#environmentName = options.environmentName;
    this.#executablePath = options.executablePath;
    this.#logPath = options.logPath;
    this.#modulePath = options.modulePath;
    this.#onStatus = options.onStatus;
  }

  get environmentName(): string {
    return this.#environmentName;
  }

  start(): Promise<void> {
    this.#desiredRunning = true;
    return this.#enqueue(() => this.#startChild());
  }

  restart(environmentName = this.#environmentName): Promise<void> {
    this.#environmentName = environmentName;
    this.#desiredRunning = true;
    this.#clearRestartTimer();
    return this.#enqueue(async () => {
      await this.#stopChild();
      this.#restartAttempts = 0;
      await this.#startChild();
    });
  }

  stop(): Promise<void> {
    this.#desiredRunning = false;
    this.#clearRestartTimer();
    return this.#enqueue(async () => {
      await this.#stopChild();
      this.#emit({ kind: "stopped" });
    });
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    const run = this.#lifecycle.then(operation, operation);
    this.#lifecycle = run.catch(() => undefined);
    return run;
  }

  async #startChild(): Promise<void> {
    if (this.#child || !this.#desiredRunning) return;
    this.#emit({ kind: "starting" });
    await mkdir(dirname(this.#logPath), { recursive: true });
    await this.#log(`Starting Letta Code as "${this.#environmentName}".`);
    if (this.#child || !this.#desiredRunning) return;

    let child: ChildProcess;
    try {
      child = spawn(
        this.#executablePath,
        [
          this.#cliPath,
          "server",
          "--computer-name",
          this.#environmentName,
          "--host-protocol",
          "stdio",
        ],
        {
          cwd: homedir(),
          detached: process.platform !== "win32",
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: "1",
            LETTA_CODE_BIN: this.#executablePath,
            LETTA_CODE_BIN_ARGS_JSON: JSON.stringify([this.#cliPath]),
            LETTA_CODE_DESKTOP_MANAGED: "1",
            LETTA_DAEMON_MANAGED: "1",
            LETTA_DAEMON_PARENT_PID: String(process.pid),
            NODE_PATH: [this.#modulePath, process.env.NODE_PATH]
              .filter(Boolean)
              .join(process.platform === "win32" ? ";" : ":"),
          },
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        },
      );
    } catch (error) {
      this.#handleStartFailure(error);
      return;
    }

    this.#child = child;
    this.#readyAt = null;
    const stdoutState = { buffer: "" };
    let finished = false;
    const finish = (
      code: number | null,
      signal: NodeJS.Signals | null,
      error?: Error,
    ): void => {
      if (finished) return;
      finished = true;
      this.#finishChild(child, code, signal, error);
    };

    child.stdout?.on("data", (chunk: Buffer) =>
      this.#handleStdout(child, stdoutState, chunk),
    );
    child.stderr?.on("data", (chunk: Buffer) => {
      void this.#log(chunk.toString("utf8").trimEnd());
    });
    child.once("error", (error) => finish(null, null, error));
    child.once("exit", (code, signal) => finish(code, signal));
  }

  async #stopChild(): Promise<void> {
    const child = this.#child;
    if (!child) return;
    this.#expectedExits.add(child);
    await terminateChild(child, GRACEFUL_STOP_MS);
    if (this.#child === child) this.#child = null;
  }

  #finishChild(
    child: ChildProcess,
    code: number | null,
    signal: NodeJS.Signals | null,
    error?: Error,
  ): void {
    if (this.#child === child) this.#child = null;
    if (wasListenerStable(this.#readyAt, Date.now())) this.#restartAttempts = 0;
    this.#readyAt = null;
    const expected = this.#expectedExits.delete(child);
    const detail = error?.message ?? code ?? signal ?? "unknown";
    void this.#log(
      error
        ? `Listener process error: ${error.message}`
        : `Listener exited (code=${code ?? "none"}, signal=${signal ?? "none"}).`,
    );
    if (error) this.#emit({ kind: "error", detail: error.message });
    if (expected || !this.#desiredRunning) {
      if (!this.#desiredRunning) this.#emit({ kind: "stopped" });
      return;
    }
    this.#scheduleRestart(detail);
  }

  #handleStartFailure(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    void this.#log(`Listener process error: ${message}`);
    this.#emit({ kind: "error", detail: message });
    if (this.#desiredRunning) this.#scheduleRestart(message);
  }

  #handleStdout(
    child: ChildProcess,
    state: { buffer: string },
    chunk: Buffer,
  ): void {
    if (this.#child !== child) return;
    state.buffer += chunk.toString("utf8");
    const lines = state.buffer.split(/\r?\n/);
    state.buffer = lines.pop() ?? "";
    for (const line of lines) {
      const event = parseHostEventLine(line);
      if (event) this.#handleHostEvent(event);
      else if (line) void this.#log(line);
    }
  }

  #handleHostEvent(event: HostEvent): void {
    void this.#log(`${HOST_EVENT_PREFIX}${JSON.stringify(event)}`);
    if (event.type === "ready") {
      this.#readyAt ??= Date.now();
      this.#emit({ kind: "connected" });
      return;
    }
    if (event.type === "processing") {
      this.#emit({ kind: "working" });
      return;
    }
    if (event.type === "reconnecting") {
      this.#emit({
        kind: "reconnecting",
        detail: `Retrying in ${Math.ceil(event.retryInMs / 1000)}s`,
      });
      return;
    }
    this.#emit({ kind: "error", detail: event.message });
  }

  #scheduleRestart(exitDetail: string | number): void {
    if (!this.#desiredRunning || this.#restartTimer) return;
    this.#restartAttempts += 1;
    const delay = Math.min(
      1_000 * 2 ** (this.#restartAttempts - 1),
      MAX_RESTART_DELAY_MS,
    );
    this.#emit({
      kind: "reconnecting",
      detail: `Listener exited (${exitDetail}); retrying in ${Math.ceil(delay / 1000)}s`,
    });
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = null;
      if (!this.#desiredRunning) return;
      void this.#enqueue(() => this.#startChild()).catch((error: unknown) =>
        this.#handleStartFailure(error),
      );
    }, delay);
  }

  #clearRestartTimer(): void {
    if (!this.#restartTimer) return;
    clearTimeout(this.#restartTimer);
    this.#restartTimer = null;
  }

  #emit(status: DaemonStatus): void {
    this.#onStatus(status);
  }

  async #log(message: string): Promise<void> {
    if (!message) return;
    const timestamp = new Date().toISOString();
    await appendFile(
      this.#logPath,
      `[${timestamp}] ${message}\n`,
      "utf8",
    ).catch(() => undefined);
  }
}

async function terminateChild(
  child: ChildProcess,
  timeoutMs: number,
): Promise<void> {
  const exited = waitForChildExit(child);
  if (!child.pid || hasChildExited(child)) return;

  sendGracefulShutdown(child);

  if (await settlesWithin(exited, timeoutMs)) return;
  if (!child.pid || hasChildExited(child)) return;

  if (process.platform === "win32") {
    await runTaskkill(child.pid, true);
  } else {
    signalProcessGroup(child, "SIGKILL");
  }
  await settlesWithin(exited, FINAL_STOP_WAIT_MS);
}

function hasChildExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForChildExit(child: ChildProcess): Promise<void> {
  if (hasChildExited(child)) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

function sendGracefulShutdown(child: ChildProcess): void {
  const stdin = child.stdin;
  if (!stdin || stdin.destroyed || !stdin.writable) return;
  // A still-running child can close its input between the checks above and
  // this write. EPIPE is expected in that race and must not crash the tray.
  stdin.once("error", () => undefined);
  try {
    stdin.end(HOST_SHUTDOWN_COMMAND);
  } catch {
    // The forced process-tree fallback below remains responsible for cleanup.
  }
}

async function runTaskkill(pid: number, force: boolean): Promise<void> {
  const args = ["/T", ...(force ? ["/F"] : []), "/PID", String(pid)];
  const taskkill = spawn("taskkill", args, {
    stdio: "ignore",
    windowsHide: true,
  });
  await settlesWithin(
    new Promise<void>((resolve) => {
      taskkill.once("error", () => resolve());
      taskkill.once("exit", () => resolve());
    }),
    FINAL_STOP_WAIT_MS,
  );
}

async function settlesWithin(
  promise: Promise<void>,
  timeoutMs: number,
): Promise<boolean> {
  return Promise.race([
    promise.then(() => true),
    new Promise<boolean>((resolve) =>
      setTimeout(() => resolve(false), timeoutMs),
    ),
  ]);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
