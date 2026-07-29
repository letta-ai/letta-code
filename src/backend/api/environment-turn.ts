import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import type { Message } from "@letta-ai/letta-client/resources/agents/messages";
import type { StopReasonType } from "@letta-ai/letta-client/resources/runs/runs";
import type { Backend } from "@/backend/backend";
import {
  type GithubRepositoryRef,
  resolveAgentSandboxConnectionId,
  sendEnvironmentMessage,
} from "./environments";

function pageItems<T>(page: unknown): T[] {
  if (!page || typeof page !== "object") return [];
  const candidate = page as {
    getPaginatedItems?: () => T[];
    items?: T[];
  };
  if (typeof candidate.getPaginatedItems === "function") {
    return candidate.getPaginatedItems();
  }
  return Array.isArray(candidate.items) ? candidate.items : [];
}

function extractMessageText(message: Message): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (
        part &&
        typeof part === "object" &&
        "type" in part &&
        part.type === "text" &&
        "text" in part &&
        typeof part.text === "string"
      ) {
        return part.text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function messageTime(message: Message): number {
  const raw =
    (message as { date?: string; created_at?: string }).date ??
    (message as { created_at?: string }).created_at;
  return raw ? new Date(raw).getTime() : 0;
}

function lastRunCompletionMs(agent: AgentState): number | null {
  const raw = (agent as { last_run_completion?: unknown }).last_run_completion;
  if (typeof raw !== "string" || raw.length === 0) return null;
  const value = new Date(raw).getTime();
  return Number.isFinite(value) ? value : null;
}

function lastStopReason(agent: AgentState): StopReasonType | null {
  const raw = (agent as { last_stop_reason?: unknown }).last_stop_reason;
  return typeof raw === "string" && raw.length > 0
    ? (raw as StopReasonType)
    : null;
}

async function waitForAssistantMessage(params: {
  backend: Backend;
  agentId: string;
  conversationId: string;
  startedAtMs: number;
  baselineCompletionMs: number | null;
  timeoutMs?: number;
  pollIntervalMs?: number;
}): Promise<{ text: string; stopReason: StopReasonType | null }> {
  const deadline = Date.now() + (params.timeoutMs ?? 10 * 60_000);
  const pollIntervalMs = params.pollIntervalMs ?? 1_000;
  let lastText = "";
  let completionObserved = false;
  let stablePolls = 0;
  let stopReason: StopReasonType | null = null;

  while (Date.now() < deadline) {
    const agent = await params.backend.retrieveAgent(params.agentId);
    const completionMs = lastRunCompletionMs(agent);
    if (
      completionMs !== null &&
      (params.baselineCompletionMs === null ||
        completionMs > params.baselineCompletionMs) &&
      completionMs >= params.startedAtMs - 5_000
    ) {
      completionObserved = true;
      stopReason = lastStopReason(agent);
    }

    const page =
      params.conversationId === "default"
        ? await params.backend.listAgentMessages(params.agentId, {
            conversation_id: "default",
            limit: 50,
            order: "desc",
          })
        : await params.backend.listConversationMessages(params.conversationId, {
            limit: 50,
            order: "desc",
          });
    const assistant = pageItems<Message>(page)
      .filter(
        (message) =>
          message.message_type === "assistant_message" &&
          messageTime(message) >= params.startedAtMs - 2_000,
      )
      .sort((a, b) => messageTime(b) - messageTime(a))[0];
    const text = assistant ? extractMessageText(assistant).trim() : "";

    if (text) {
      stablePolls = text === lastText ? stablePolls + 1 : 0;
      lastText = text;
      if (completionObserved && stablePolls >= 1) {
        return { text, stopReason };
      }
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  if (completionObserved && lastText) return { text: lastText, stopReason };
  throw new Error("Timed out waiting for the Cloud turn to complete");
}

export async function prepareCloudConversation(params: {
  agentId: string;
  conversationId: string;
  githubRepositories?: GithubRepositoryRef[];
  forceNew?: boolean;
}): Promise<{ connectionId: string; deviceId: string; name: string }> {
  const { connectionId, environment } = await resolveAgentSandboxConnectionId(
    params.agentId,
    {
      conversationId: params.conversationId,
      githubRepositories: params.githubRepositories,
      forceNew: params.forceNew,
    },
  );
  if (environment.metadata?.environmentMessageProtocol !== "v2-input") {
    throw new Error(
      `Cloud is running Letta Code ${environment.metadata?.lettaCodeVersion ?? "unknown"}, which does not support conversation handoff.`,
    );
  }
  return {
    connectionId,
    deviceId: environment.deviceId,
    name: environment.connectionName,
  };
}

export async function sendCloudConversationTurn(params: {
  backend: Backend;
  agentId: string;
  conversationId: string;
  messages: Array<Record<string, unknown>>;
  githubRepositories?: GithubRepositoryRef[];
  connectionId?: string;
}): Promise<{ text: string; stopReason: StopReasonType | null }> {
  const agent = await params.backend.retrieveAgent(params.agentId);
  const baselineCompletionMs = lastRunCompletionMs(agent);
  const connectionId =
    params.connectionId ??
    (await prepareCloudConversation(params)).connectionId;
  const startedAtMs = Date.now();

  await sendEnvironmentMessage(connectionId, {
    agentId: params.agentId,
    conversationId: params.conversationId,
    messages: params.messages,
  });

  return waitForAssistantMessage({
    backend: params.backend,
    agentId: params.agentId,
    conversationId: params.conversationId,
    startedAtMs,
    baselineCompletionMs,
  });
}
