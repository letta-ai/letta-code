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
export const CHANNEL_GATEWAY_READY_SIGNAL = "CHANNEL_GATEWAY_READY";
const RESPONSE_PREFIX = "CHANNEL_GATEWAY_RESPONSE ";
const EVENT_PREFIX = "CHANNEL_GATEWAY_EVENT ";

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
  onServiceEvent?: (event: ServiceEvent) => void;
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
  let child: ChildProcess | null = null;
  let stopping = false;
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

  const launch = (): void => {
    if (stopping) return;
    child = (options.spawnProcess ?? spawn)(launcher.command, childArgs, {
      cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const launchedChild = child;
    options.onLog?.(
      `[ChannelGateway] started pid=${launchedChild.pid ?? "unknown"}`,
    );
    launchedChild.stdout?.setEncoding("utf8");
    let stdoutBuffer = "";
    launchedChild.stdout?.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";
      for (const rawLine of lines) {
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        if (line === CHANNEL_GATEWAY_READY_SIGNAL) {
          resolveInitialReady?.();
          resolveInitialReady = null;
          rejectInitialReady = null;
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
      rejectInitialReady?.(error);
      resolveInitialReady = null;
      rejectInitialReady = null;
    });
    launchedChild.once("exit", (code, signal) => {
      if (child === launchedChild) child = null;
      if (stopping) return;
      if (rejectInitialReady) {
        rejectInitialReady(
          new Error(
            `ChannelGateway exited before ready (${signal ?? code ?? "unknown"})`,
          ),
        );
        resolveInitialReady = null;
        rejectInitialReady = null;
      }
      const error = new Error(
        `ChannelGateway exited unexpectedly (${signal ?? code ?? "unknown"})`,
      );
      options.onLog?.(`[ChannelGateway] ${error.message}`);
      for (const pending of pendingCommands.values()) {
        clearTimeout(pending.timeout);
        pending.reject(error);
      }
      pendingCommands.clear();
      options.onUnexpectedExit?.(error);
    });
  };

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
        const activeChild = child;
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
      const activeChild = child;
      child = null;
      const closeError = new Error("ChannelGateway supervisor closed");
      for (const pending of pendingCommands.values()) {
        clearTimeout(pending.timeout);
        pending.reject(closeError);
      }
      pendingCommands.clear();
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
