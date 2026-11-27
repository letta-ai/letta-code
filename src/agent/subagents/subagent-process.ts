import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { getClient } from "@/backend/api/client";
import { resolveMcpOriginatorToken } from "@/backend/api/mcp-originator-resolver";
import {
  createMcpSubprocessBroker,
  MCP_SUBPROCESS_BROKER_SOCKET_ENV,
} from "@/backend/api/mcp-subprocess-broker";
import { getRuntimeContext } from "@/runtime-context";
import { getCommandProcessFactory } from "@/utils/package-manager-spawn";
import { wrapManagedWorkloadLauncher } from "@/utils/systemd-workload-scope";

const DEFAULT_FORCE_KILL_GRACE_MS = 2_000;
const FORCE_KILL_SETTLE_MS = 500;
const PROCESS_EXIT_POLL_MS = 20;

export interface SubagentProcessExit {
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
}

interface SpawnSubagentProcessOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  forceKillGraceMs?: number;
}

export interface RunningSubagentProcess {
  process: ChildProcessWithoutNullStreams;
  completion: Promise<SubagentProcessExit>;
  wasAborted(): boolean;
}

function signalProcessGroup(
  childProcess: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
): void {
  if (!childProcess.pid) return;

  try {
    process.kill(-childProcess.pid, signal);
  } catch {
    try {
      childProcess.kill(signal);
    } catch {}
  }
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitForProcessGroupExit(
  pid: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processGroupExists(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, PROCESS_EXIT_POLL_MS));
  }
  return true;
}

export async function killWindowsProcessTree(
  childProcess: ChildProcessWithoutNullStreams,
): Promise<void> {
  if (!childProcess.pid) return;

  await new Promise<void>((resolve) => {
    const taskkill = spawn(
      "taskkill.exe",
      ["/pid", String(childProcess.pid), "/t", "/f"],
      { stdio: "ignore", windowsHide: true },
    );
    let settled = false;
    const finish = (succeeded: boolean) => {
      if (settled) return;
      settled = true;
      if (!succeeded) {
        try {
          childProcess.kill("SIGKILL");
        } catch {}
      }
      resolve();
    };
    taskkill.once("error", () => finish(false));
    taskkill.once("close", (code) => finish(code === 0));
  });
}

async function terminateSubagentProcessTree(
  childProcess: ChildProcessWithoutNullStreams,
  forceKillGraceMs: number,
): Promise<void> {
  if (!childProcess.pid) return;

  if (process.platform === "win32") {
    await killWindowsProcessTree(childProcess);
    return;
  }

  const pid = childProcess.pid;
  signalProcessGroup(childProcess, "SIGINT");
  if (await waitForProcessGroupExit(pid, forceKillGraceMs)) return;

  signalProcessGroup(childProcess, "SIGKILL");
  await waitForProcessGroupExit(pid, FORCE_KILL_SETTLE_MS);
}

export function spawnSubagentProcess(
  command: string,
  args: string[],
  options: SpawnSubagentProcessOptions,
): RunningSubagentProcess {
  const context = getRuntimeContext();
  const brokerAgentId = context?.agentId;
  const broker =
    brokerAgentId && !options.env[MCP_SUBPROCESS_BROKER_SOCKET_ENV]
      ? createMcpSubprocessBroker({
          agentId: brokerAgentId,
          getAllowedAgentIds: async () =>
            new Set(
              [brokerAgentId, options.env.LETTA_PARENT_AGENT_ID].filter(
                (id): id is string => !!id,
              ),
            ),
          getScope: () => {
            const runId =
              context.resolveMcpOriginatorSuperRunId?.() ??
              context.mcpOriginatorSuperRunId;
            return {
              agentId: brokerAgentId,
              ...(runId
                ? { originatorToken: resolveMcpOriginatorToken(runId) }
                : {}),
            };
          },
          getClient: async () => await getClient(),
        })
      : null;
  let childProcess: ChildProcessWithoutNullStreams;
  try {
    childProcess = getCommandProcessFactory()(command, args, {
      cwd: options.cwd,
      env: { ...options.env, ...broker?.env },
      detached: process.platform !== "win32",
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;
  } catch (error) {
    broker?.close();
    throw error;
  }
  let aborted = false;
  let termination: Promise<void> = Promise.resolve();

  const abortHandler = () => {
    if (aborted) return;
    aborted = true;
    termination = terminateSubagentProcessTree(
      childProcess,
      options.forceKillGraceMs ?? DEFAULT_FORCE_KILL_GRACE_MS,
    );
  };

  options.signal?.addEventListener("abort", abortHandler, { once: true });
  if (options.signal?.aborted) abortHandler();

  const processExit = new Promise<SubagentProcessExit>((resolve) => {
    let settled = false;
    const finish = (result: SubagentProcessExit) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    childProcess.once("close", (exitCode, exitSignal) =>
      finish({ exitCode, exitSignal }),
    );
    childProcess.once("error", () =>
      finish({ exitCode: null, exitSignal: null }),
    );
  });

  const completion = processExit.then(async (result) => {
    broker?.close();
    if (aborted) await termination;
    options.signal?.removeEventListener("abort", abortHandler);
    return result;
  });

  return {
    process: childProcess,
    completion,
    wasAborted: () => aborted,
  };
}

export function spawnManagedWorkloadProcess(
  command: string,
  args: string[],
  options: SpawnSubagentProcessOptions,
): RunningSubagentProcess {
  const [managedCommand = command, ...managedArgs] =
    wrapManagedWorkloadLauncher([command, ...args], { env: options.env });
  return spawnSubagentProcess(managedCommand, managedArgs, options);
}
