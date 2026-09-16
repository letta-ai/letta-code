import { type ChildProcess, spawn } from "node:child_process";
import {
  resolveEntryScriptPath,
  resolveLettaInvocation,
} from "@/tools/impl/shell-env";
import type {
  ServiceCommandRequest,
  ServiceCommandResponse,
  ServiceEvent,
} from "@/types/service-protocol";
import type { ChannelRestoreAgentScope } from "./restore-scope";

const SHUTDOWN_TIMEOUT_MS = 5000;
const STARTUP_TIMEOUT_MS = 30000;
const COMMAND_TIMEOUT_MS = 30000;
const DEFAULT_RESTART_MAX_ATTEMPTS = 5;
const DEFAULT_RESTART_INITIAL_DELAY_MS = 1000;
const DEFAULT_RESTART_MAX_DELAY_MS = 30000;
const DEFAULT_RESTART_STABLE_AFTER_MS = 60000;
export const CHANNEL_GATEWAY_READY_SIGNAL = "CHANNEL_GATEWAY_READY";
const RESPONSE_PREFIX = "CHANNEL_GATEWAY_RESPONSE ";
const EVENT_PREFIX = "CHANNEL_GATEWAY_EVENT ";

export interface ChannelGatewayRestartPolicy {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  stableAfterMs: number;
  readyTimeoutMs: number;
  shutdownTimeoutMs: number;
}

export interface ChannelGatewayLifecycleEvent {
  kind:
    | "exit"
    | "process_error"
    | "restart_scheduled"
    | "restart_ready"
    | "restart_exhausted";
  restartAttempt: number;
  maxRestartAttempts: number;
  durationMs?: number;
  delayMs?: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  reachedReady?: boolean;
}

export interface StartChannelGatewaySupervisorOptions {
  appServerUrl: string;
  channelNames: string[];
  restoreEnabledChannels?: boolean;
  restoreAgentScope?: ChannelRestoreAgentScope | null;
  failOnStartupError?: boolean;
  installChannelRuntimes?: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  onLog?: (message: string) => void;
  onUnexpectedExit?: (error: Error) => void;
  onRestartExhausted?: (error: Error) => void;
  onLifecycleEvent?: (event: ChannelGatewayLifecycleEvent) => void;
  onServiceEvent?: (event: ServiceEvent) => void;
  /** Override restart timing for deterministic embedding/tests. */
  restartPolicy?: Partial<ChannelGatewayRestartPolicy>;
  /** Override the executable used to launch the gateway (embedding/tests). */
  launcher?: { command: string; args?: string[] };
  /** Override child creation for deterministic supervisor protocol tests. */
  spawnProcess?: typeof spawn;
}

export interface ChannelGatewaySupervisor {
  close(): Promise<void>;
  request(command: ServiceCommandRequest): Promise<ServiceCommandResponse>;
}

function resolveLauncher(cwd: string): { command: string; args: string[] } {
  const invocation = resolveLettaInvocation(
    process.env,
    process.argv,
    process.execPath,
    cwd,
  );
  if (invocation) return invocation;

  const currentScript = process.argv[1] ?? "";
  const entrypoint = resolveEntryScriptPath(currentScript, cwd);
  if (currentScript.endsWith(".ts")) {
    return { command: process.execPath, args: [entrypoint] };
  }
  if (currentScript.endsWith(".js") && process.platform === "win32") {
    return { command: process.execPath, args: [entrypoint] };
  }
  if (currentScript.endsWith(".js")) {
    return { command: entrypoint, args: [] };
  }
  return { command: "letta", args: [] };
}

export async function startChannelGatewaySupervisor(
  options: StartChannelGatewaySupervisorOptions,
): Promise<ChannelGatewaySupervisor> {
  const cwd = options.cwd ?? process.cwd();
  const launcher = options.launcher
    ? { command: options.launcher.command, args: options.launcher.args ?? [] }
    : resolveLauncher(cwd);
  const childArgs = [
    ...launcher.args,
    "channel-gateway",
    "--app-server-url",
    options.appServerUrl,
    "--channels",
    options.channelNames.join(","),
    ...(options.restoreEnabledChannels ? ["--restore-enabled-channels"] : []),
    ...(options.restoreAgentScope
      ? ["--restore-agent-scope", options.restoreAgentScope]
      : []),
    ...(options.failOnStartupError === false ? ["--allow-startup-errors"] : []),
    ...(options.installChannelRuntimes ? ["--install-channel-runtimes"] : []),
  ];
  const restartPolicy: ChannelGatewayRestartPolicy = {
    maxAttempts: Math.max(
      0,
      Math.floor(
        options.restartPolicy?.maxAttempts ?? DEFAULT_RESTART_MAX_ATTEMPTS,
      ),
    ),
    initialDelayMs: Math.max(
      0,
      options.restartPolicy?.initialDelayMs ?? DEFAULT_RESTART_INITIAL_DELAY_MS,
    ),
    maxDelayMs: Math.max(
      0,
      options.restartPolicy?.maxDelayMs ?? DEFAULT_RESTART_MAX_DELAY_MS,
    ),
    stableAfterMs: Math.max(
      0,
      options.restartPolicy?.stableAfterMs ?? DEFAULT_RESTART_STABLE_AFTER_MS,
    ),
    readyTimeoutMs: Math.max(
      1,
      options.restartPolicy?.readyTimeoutMs ?? STARTUP_TIMEOUT_MS,
    ),
    shutdownTimeoutMs: Math.max(
      1,
      options.restartPolicy?.shutdownTimeoutMs ?? SHUTDOWN_TIMEOUT_MS,
    ),
  };
  let child: ChildProcess | null = null;
  let readyChild: ChildProcess | null = null;
  let stopping = false;
  let initialReadyCompleted = false;
  let restartAttempts = 0;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let stableTimer: ReturnType<typeof setTimeout> | null = null;
  let resolveInitialReady: (() => void) | null = null;
  let rejectInitialReady: ((error: Error) => void) | null = null;
  const pendingCommands = new Map<
    string,
    {
      resolve: (response: ServiceCommandResponse) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  const initialReady = new Promise<void>((resolve, reject) => {
    resolveInitialReady = resolve;
    rejectInitialReady = reject;
  });

  function clearStableTimer(): void {
    if (!stableTimer) return;
    clearTimeout(stableTimer);
    stableTimer = null;
  }

  function rejectPendingCommands(error: Error): void {
    for (const pending of pendingCommands.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    pendingCommands.clear();
  }

  function scheduleRestart(lastError: Error): void {
    if (stopping) return;
    if (restartAttempts >= restartPolicy.maxAttempts) {
      const exhaustedError = new Error(
        `${lastError.message}; restart attempts exhausted (${restartPolicy.maxAttempts})`,
      );
      options.onLog?.(`[ChannelGateway] ${exhaustedError.message}`);
      options.onLifecycleEvent?.({
        kind: "restart_exhausted",
        restartAttempt: restartAttempts,
        maxRestartAttempts: restartPolicy.maxAttempts,
      });
      options.onRestartExhausted?.(exhaustedError);
      return;
    }

    restartAttempts += 1;
    const multiplier = 2 ** Math.min(restartAttempts - 1, 30);
    const delayMs = Math.min(
      restartPolicy.initialDelayMs * multiplier,
      restartPolicy.maxDelayMs,
    );
    options.onLog?.(
      `[ChannelGateway] restart attempt ${restartAttempts}/${restartPolicy.maxAttempts} in ${delayMs}ms`,
    );
    options.onLifecycleEvent?.({
      kind: "restart_scheduled",
      restartAttempt: restartAttempts,
      maxRestartAttempts: restartPolicy.maxAttempts,
      delayMs,
    });
    restartTimer = setTimeout(() => {
      restartTimer = null;
      launch();
    }, delayMs);
    restartTimer.unref?.();
  }

  function launch(): void {
    if (stopping) return;
    child = (options.spawnProcess ?? spawn)(launcher.command, childArgs, {
      cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const launchedChild = child;
    const launchedRestartAttempt = restartAttempts;
    const launchedAt = Date.now();
    let generationReady = false;
    let terminationHandled = false;
    let forcedTerminationError: Error | null = null;
    let readyTimeout: ReturnType<typeof setTimeout> | null = null;
    let readyForceKillTimeout: ReturnType<typeof setTimeout> | null = null;

    function clearReadyTimeouts(): void {
      if (readyTimeout) clearTimeout(readyTimeout);
      readyTimeout = null;
      if (readyForceKillTimeout) clearTimeout(readyForceKillTimeout);
      readyForceKillTimeout = null;
    }

    if (initialReadyCompleted) {
      readyTimeout = setTimeout(() => {
        if (generationReady || terminationHandled) return;
        forcedTerminationError = new Error(
          `ChannelGateway restart attempt ${launchedRestartAttempt} timed out waiting for ready`,
        );
        terminateChild(launchedChild, "SIGTERM");
        readyForceKillTimeout = setTimeout(() => {
          if (generationReady || terminationHandled) return;
          terminateChild(launchedChild, "SIGKILL");
        }, restartPolicy.shutdownTimeoutMs);
        readyForceKillTimeout.unref?.();
      }, restartPolicy.readyTimeoutMs);
      readyTimeout.unref?.();
    }

    const handleTermination = (
      error: Error,
      event: Pick<ChannelGatewayLifecycleEvent, "kind" | "exitCode" | "signal">,
    ): void => {
      if (terminationHandled) return;
      terminationHandled = true;
      clearReadyTimeouts();
      clearStableTimer();
      if (child === launchedChild) child = null;
      if (readyChild === launchedChild) readyChild = null;
      if (stopping) return;

      options.onLifecycleEvent?.({
        ...event,
        restartAttempt: launchedRestartAttempt,
        maxRestartAttempts: restartPolicy.maxAttempts,
        durationMs: Date.now() - launchedAt,
        reachedReady: generationReady,
      });
      options.onLog?.(`[ChannelGateway] ${error.message}`);
      rejectPendingCommands(error);
      options.onUnexpectedExit?.(error);
      if (!initialReadyCompleted) {
        rejectInitialReady?.(error);
        resolveInitialReady = null;
        rejectInitialReady = null;
        return;
      }
      scheduleRestart(error);
    };

    options.onLog?.(
      `[ChannelGateway] started pid=${launchedChild.pid ?? "unknown"}`,
    );
    launchedChild.stdout?.setEncoding("utf8");
    let stdoutBuffer = "";
    launchedChild.stdout?.on("data", (chunk: string) => {
      if (terminationHandled) return;
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";
      for (const rawLine of lines) {
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        if (line === CHANNEL_GATEWAY_READY_SIGNAL) {
          if (generationReady) continue;
          generationReady = true;
          clearReadyTimeouts();
          readyChild = launchedChild;
          if (!initialReadyCompleted) {
            initialReadyCompleted = true;
            resolveInitialReady?.();
            resolveInitialReady = null;
            rejectInitialReady = null;
          } else {
            options.onLog?.(
              `[ChannelGateway] restart attempt ${launchedRestartAttempt}/${restartPolicy.maxAttempts} ready`,
            );
            options.onLifecycleEvent?.({
              kind: "restart_ready",
              restartAttempt: launchedRestartAttempt,
              maxRestartAttempts: restartPolicy.maxAttempts,
              durationMs: Date.now() - launchedAt,
            });
            clearStableTimer();
            stableTimer = setTimeout(() => {
              stableTimer = null;
              if (readyChild !== launchedChild || stopping) return;
              restartAttempts = 0;
              options.onLog?.(
                `[ChannelGateway] restart budget reset after ${restartPolicy.stableAfterMs}ms stable`,
              );
            }, restartPolicy.stableAfterMs);
            stableTimer.unref?.();
          }
        } else if (line.startsWith(RESPONSE_PREFIX)) {
          let response: {
            requestId: string;
            response?: ServiceCommandResponse;
            error?: string;
          };
          try {
            response = JSON.parse(line.slice(RESPONSE_PREFIX.length));
          } catch {
            options.onLog?.("[ChannelGateway] malformed command response");
            continue;
          }
          const pending = pendingCommands.get(response.requestId);
          if (!pending) continue;
          clearTimeout(pending.timeout);
          pendingCommands.delete(response.requestId);
          if (response.error) pending.reject(new Error(response.error));
          else if (response.response) pending.resolve(response.response);
          else pending.reject(new Error("ChannelGateway response is missing"));
        } else if (line.startsWith(EVENT_PREFIX)) {
          try {
            const event = JSON.parse(
              line.slice(EVENT_PREFIX.length),
            ) as ServiceEvent;
            options.onServiceEvent?.(event);
          } catch {
            options.onLog?.("[ChannelGateway] malformed service event");
          }
        } else if (line) {
          options.onLog?.(`[ChannelGateway] ${line}`);
        }
      }
    });
    launchedChild.stderr?.setEncoding("utf8");
    launchedChild.stderr?.on("data", (chunk: string) => {
      for (const line of chunk.trimEnd().split("\n")) {
        if (line) options.onLog?.(`[ChannelGateway] ${line}`);
      }
    });
    launchedChild.once("error", (error) => {
      options.onLog?.(`[ChannelGateway] process error: ${error.message}`);
      if (!generationReady) {
        handleTermination(error, {
          kind: "process_error",
          exitCode: null,
          signal: null,
        });
      }
    });
    launchedChild.once("exit", (code, signal) => {
      handleTermination(
        forcedTerminationError ??
          new Error(
            generationReady
              ? `ChannelGateway exited unexpectedly (${signal ?? code ?? "unknown"})`
              : `ChannelGateway exited before ready (${signal ?? code ?? "unknown"})`,
          ),
        { kind: "exit", exitCode: code, signal },
      );
    });
  }

  launch();

  const startupTimeout = setTimeout(() => {
    rejectInitialReady?.(new Error("Timed out waiting for ChannelGateway"));
    resolveInitialReady = null;
    rejectInitialReady = null;
  }, STARTUP_TIMEOUT_MS);
  try {
    await initialReady;
  } catch (error) {
    stopping = true;
    terminateChild(child, "SIGTERM");
    throw error;
  } finally {
    clearTimeout(startupTimeout);
  }

  return {
    request: (command) =>
      new Promise<ServiceCommandResponse>((resolve, reject) => {
        const activeChild = readyChild;
        if (!activeChild?.stdin?.writable) {
          reject(new Error("ChannelGateway process is not available"));
          return;
        }
        const requestId = crypto.randomUUID();
        const timeout = setTimeout(() => {
          pendingCommands.delete(requestId);
          reject(
            new Error(`ChannelGateway command timed out: ${command.kind}`),
          );
        }, COMMAND_TIMEOUT_MS);
        pendingCommands.set(requestId, { resolve, reject, timeout });
        activeChild.stdin.write(
          `${JSON.stringify({ type: "command", requestId, command })}\n`,
          (error) => {
            if (!error) return;
            clearTimeout(timeout);
            pendingCommands.delete(requestId);
            reject(error);
          },
        );
      }),
    close: async () => {
      if (stopping) return;
      stopping = true;
      if (restartTimer) clearTimeout(restartTimer);
      restartTimer = null;
      clearStableTimer();
      const activeChild = child;
      child = null;
      readyChild = null;
      const closeError = new Error("ChannelGateway supervisor closed");
      rejectPendingCommands(closeError);
      if (!activeChild || activeChild.exitCode !== null) return;
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          activeChild.kill("SIGKILL");
          resolve();
        }, SHUTDOWN_TIMEOUT_MS);
        activeChild.once("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
        activeChild.kill("SIGTERM");
      });
    },
  };
}

function terminateChild(
  child: ChildProcess | null,
  signal: NodeJS.Signals,
): void {
  child?.kill(signal);
}
