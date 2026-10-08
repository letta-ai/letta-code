/**
 * Runs a claude-code/codex worker on a connected computer. The computer
 * launches it with `notify: "caller"` and publishes the final report on its
 * subagent snapshot; this process owns the local task and its notification.
 */
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { updateSubagent } from "@/agent/subagent-state";
import type { SubagentConfig, SubagentResult } from "@/agent/subagents";
import type { spawnSubagent } from "@/agent/subagents/manager";
import {
  type AppServerClient,
  createAppServerClient,
} from "@/app-server-client";
import {
  type EnvironmentConnection,
  resolveAgentSandboxConnectionId,
  resolveEnvironmentConnectionId,
} from "@/backend/api/environments";
import { getApiRequestConfig } from "@/backend/api/request";
import { isCloudEnvironmentSelector } from "@/headless-environment-response";
import { listenerControlUrl } from "@/headless-listener-launch";
import type { SubagentSnapshot } from "@/types/protocol_v2";
import type {
  SubagentLaunchResult,
  SubagentStartupErrorCode,
} from "@/types/subagent-protocol";
import {
  createExternalCodingAgentConfig,
  type ExternalCodingAgentMcpOptions,
  type ExternalCodingAgentType,
} from "./external-coding-agent";

interface ParentScope {
  agentId: string;
  conversationId: string;
  actingUserId?: string;
}

/** The subset of spawnBackgroundSubagentTask used here (injected to avoid a cycle). */
export type SpawnRemoteFollowTask = (args: {
  subagentType: string;
  config: SubagentConfig;
  prompt: string;
  description: string;
  model?: string;
  toolCallId?: string;
  parentScope: ParentScope;
  deps: { spawnSubagentImpl: typeof spawnSubagent };
}) => { taskId: string; outputFile: string; subagentId: string };

export interface RemoteExternalCodingAgentLaunch {
  type: ExternalCodingAgentType;
  computer: string;
  prompt: string;
  description: string;
  model?: string;
  mcp?: ExternalCodingAgentMcpOptions;
  toolCallId?: string;
  parentScope: ParentScope;
  signal?: AbortSignal;
}

export interface RemoteExternalCodingAgentDeps {
  spawn: SpawnRemoteFollowTask;
  resolveComputer?: (
    computer: string,
    parentScope: ParentScope,
  ) => Promise<{ connectionId: string; environment: EnvironmentConnection }>;
  connect?: (
    connectionId: string,
    parentScope: ParentScope,
  ) => Promise<AppServerClient>;
  reconnectDelayMs?: number;
}

const DISPLAY_NAMES: Record<ExternalCodingAgentType, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
};

export function formatRemoteStartupError(
  type: ExternalCodingAgentType,
  computer: string,
  code: SubagentStartupErrorCode,
): string {
  const name = DISPLAY_NAMES[type];
  return code === "not_installed"
    ? `${name} isn't installed on ${computer}. Install it there, or run a Letta subagent on that computer instead.`
    : `${name} is installed on ${computer} but not signed in. Sign in there, or run a Letta subagent on that computer instead.`;
}

export function formatOutdatedComputerError(
  type: ExternalCodingAgentType,
  computer: string,
): string {
  return `${computer} is running an older Letta Code that can't run ${DISPLAY_NAMES[type]} subagents remotely. Update Letta Code on ${computer}.`;
}

async function defaultResolveComputer(computer: string, scope: ParentScope) {
  return isCloudEnvironmentSelector(computer)
    ? resolveAgentSandboxConnectionId(scope.agentId, {
        conversationId: scope.conversationId,
      })
    : resolveEnvironmentConnectionId(computer);
}

async function defaultConnect(connectionId: string, scope: ParentScope) {
  const auth = await getApiRequestConfig();
  const client = createAppServerClient({
    url: listenerControlUrl(auth.baseUrl, connectionId, {
      agent_id: scope.agentId,
      conversation_id: scope.conversationId,
    }),
    authToken: auth.apiKey,
    WebSocket,
    requestTimeoutMs: 30_000,
  });
  try {
    return await client.connect();
  } catch (error) {
    client.close();
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Follows the computer's snapshot for one launch, reconnecting if the socket drops. */
class RemoteSubagentFollower {
  private latest: SubagentSnapshot | undefined;
  private client: AppServerClient | undefined;
  private detach: (() => void) | undefined;
  private wake = Promise.withResolvers<void>();
  private closed = false;
  private disconnected = false;
  /** The computer dropped the entry before this follower saw it finish. */
  private lost = false;

  constructor(
    private readonly scope: ParentScope,
    private readonly toolCallId: string,
    private readonly connect: () => Promise<AppServerClient>,
    private readonly reconnectDelayMs: number,
  ) {}

  attach(client: AppServerClient): void {
    this.detach?.();
    this.client = client;
    this.disconnected = false;
    const offMessage = client.onMessage((message) => {
      const seq = Reflect.get(message, "seq");
      if (typeof seq === "number") client.sendRaw({ type: "ack", seq });
      if (
        message.type !== "update_subagent_state" ||
        message.runtime?.agent_id !== this.scope.agentId ||
        message.runtime.conversation_id !== this.scope.conversationId
      )
        return;
      const snapshot = message.subagents.find(
        (entry) => entry.tool_call_id === this.toolCallId,
      );
      if (snapshot) this.latest = snapshot;
      else if (this.latest) this.lost = true;
      this.wake.resolve();
    });
    const offDisconnect = client.onDisconnect(() => {
      this.disconnected = true;
      this.wake.resolve();
    });
    this.detach = () => {
      offMessage();
      offDisconnect();
    };
  }

  close(): void {
    this.closed = true;
    this.detach?.();
    this.client?.close();
    this.wake.resolve();
  }

  /** Resolves with the terminal snapshot, or throws once the computer is unreachable. */
  async waitForTerminal(
    signal: AbortSignal | undefined,
    onProgress: (snapshot: SubagentSnapshot) => void,
  ): Promise<SubagentSnapshot> {
    const onAbort = () => this.wake.resolve();
    signal?.addEventListener("abort", onAbort, { once: true });
    let failedReconnects = 0;
    try {
      while (true) {
        signal?.throwIfAborted();
        if (this.closed) throw new Error("Stopped following the subagent");
        const latest = this.latest;
        if (latest?.status === "completed" || latest?.status === "error")
          return latest;
        if (this.lost) throw new Error("Lost track of the subagent's result");
        if (latest) onProgress(latest);
        if (this.disconnected) {
          await new Promise((resolve) =>
            setTimeout(resolve, this.reconnectDelayMs * (failedReconnects + 1)),
          );
          signal?.throwIfAborted();
          try {
            const client = await this.connect();
            this.attach(client);
            // Replays the snapshot, including a completion missed while offline.
            await client.sync({
              runtime: {
                agent_id: this.scope.agentId,
                conversation_id: this.scope.conversationId,
              },
              recover_approvals: false,
            });
            failedReconnects = 0;
          } catch (error) {
            if (++failedReconnects >= 5)
              throw new Error(`Lost connection: ${errorMessage(error)}`);
          }
          continue;
        }
        await this.wake.promise;
        this.wake = Promise.withResolvers<void>();
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

export async function launchRemoteExternalCodingAgent(
  params: RemoteExternalCodingAgentLaunch,
  deps: RemoteExternalCodingAgentDeps,
): Promise<SubagentLaunchResult> {
  const { type, computer, parentScope } = params;
  let connectionId: string;
  try {
    const resolved = await (deps.resolveComputer ?? defaultResolveComputer)(
      computer,
      parentScope,
    );
    if (resolved.environment.metadata?.launch_subagent_notify_caller !== true)
      return {
        success: false,
        error: formatOutdatedComputerError(type, computer),
      };
    connectionId = resolved.connectionId;
  } catch (error) {
    return { success: false, error: errorMessage(error) };
  }
  params.signal?.throwIfAborted();

  const connect = () =>
    (deps.connect ?? defaultConnect)(connectionId, parentScope);
  const toolCallId = params.toolCallId ?? `remote-${randomUUID()}`;
  let client: AppServerClient;
  try {
    client = await connect();
  } catch (error) {
    return {
      success: false,
      error: `Can't reach ${computer}: ${errorMessage(error)}`,
    };
  }
  const follower = new RemoteSubagentFollower(
    parentScope,
    toolCallId,
    connect,
    deps.reconnectDelayMs ?? 2_000,
  );
  // Listen before launching: a fast worker can finish before the response.
  follower.attach(client);
  let launched: Awaited<ReturnType<AppServerClient["launchSubagent"]>>;
  try {
    launched = await client.launchSubagent({
      request_id: `launch-subagent-${randomUUID()}`,
      runtime: {
        agent_id: parentScope.agentId,
        conversation_id: parentScope.conversationId,
        ...(parentScope.actingUserId
          ? { acting_user_id: parentScope.actingUserId }
          : {}),
      },
      args: {
        subagent_type: type,
        prompt: params.prompt,
        description: params.description,
        ...(params.model ? { model: params.model } : {}),
        ...(params.mcp ? { mcp: params.mcp } : {}),
      },
      tool_call_id: toolCallId,
      notify: "caller",
    });
  } catch (error) {
    follower.close();
    return {
      success: false,
      error: `Couldn't launch ${type} on ${computer}: ${errorMessage(error)}`,
    };
  }
  if (!launched.success) {
    follower.close();
    return {
      success: false,
      error: launched.error_code
        ? formatRemoteStartupError(type, computer, launched.error_code)
        : `Couldn't launch ${type} on ${computer}: ${launched.error}`,
    };
  }

  const { taskId, outputFile } = deps.spawn({
    subagentType: type,
    config: createExternalCodingAgentConfig(type),
    prompt: params.prompt,
    description: params.description,
    model: params.model,
    toolCallId: params.toolCallId,
    parentScope,
    deps: {
      spawnSubagentImpl: async (_type, _prompt, model, subagentId, signal) => {
        const startedAt = Date.now();
        updateSubagent(subagentId, { status: "running" });
        try {
          const final = await follower.waitForTerminal(signal, (snapshot) =>
            updateSubagent(subagentId, {
              toolCalls: snapshot.tool_calls,
              totalTokens: snapshot.total_tokens,
            }),
          );
          return {
            agentId: parentScope.agentId,
            model: final.model ?? model,
            report: final.result ?? "",
            success: final.status === "completed",
            ...(final.status === "error"
              ? { error: final.error ?? `${type} failed on ${computer}` }
              : {}),
            totalTokens: final.total_tokens,
            durationMs: final.duration_ms || Date.now() - startedAt,
          } satisfies SubagentResult;
        } catch (error) {
          return {
            agentId: parentScope.agentId,
            model,
            report: "",
            success: false,
            // No remote stop command exists yet; the worker keeps running.
            error: `${signal?.aborted ? "Stopped following this subagent" : errorMessage(error)}. The ${type} worker may still be running on ${computer}.`,
            durationMs: Date.now() - startedAt,
          } satisfies SubagentResult;
        } finally {
          follower.close();
        }
      },
    },
  });
  return {
    success: true,
    task_id: taskId,
    output_file: outputFile,
    // The native session lives on the other computer; local follow-ups can't resume it.
    agent_id: null,
    conversation_id: null,
  };
}
