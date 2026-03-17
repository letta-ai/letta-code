import type { RuntimeScope } from "../../types/protocol_v2";
import type { ConversationRuntime, ListenerRuntime } from "./types";

function getOnlyConversationRuntime(
  runtime: ListenerRuntime | null,
): ConversationRuntime | null {
  if (!runtime || runtime.conversationRuntimes.size !== 1) {
    return null;
  }
  return runtime.conversationRuntimes.values().next().value ?? null;
}

export function normalizeCwdAgentId(agentId?: string | null): string | null {
  return agentId && agentId.length > 0 ? agentId : null;
}

export function normalizeConversationId(
  conversationId?: string | null,
): string {
  return conversationId && conversationId.length > 0
    ? conversationId
    : "default";
}

export function resolveScopedAgentId(
  runtime: ListenerRuntime | null,
  params?: {
    agent_id?: string | null;
  },
): string | null {
  if (!runtime) {
    return normalizeCwdAgentId(params?.agent_id) ?? null;
  }
  const explicitAgentId = normalizeCwdAgentId(params?.agent_id);
  if (explicitAgentId) {
    return explicitAgentId;
  }
  return getOnlyConversationRuntime(runtime)?.agentId ?? null;
}

export function resolveScopedConversationId(
  runtime: ListenerRuntime | null,
  params?: {
    conversation_id?: string | null;
  },
): string {
  if (!runtime) {
    return normalizeConversationId(params?.conversation_id);
  }
  if (params?.conversation_id) {
    return normalizeConversationId(params.conversation_id);
  }
  return (
    getOnlyConversationRuntime(runtime)?.conversationId ??
    normalizeConversationId(params?.conversation_id)
  );
}

export function resolveRuntimeScope(
  runtime: ListenerRuntime | null,
  params?: {
    agent_id?: string | null;
    conversation_id?: string | null;
  },
): RuntimeScope | null {
  const resolvedAgentId = resolveScopedAgentId(runtime, params);
  if (!resolvedAgentId) {
    return null;
  }
  const resolvedConversationId = resolveScopedConversationId(runtime, params);
  return {
    agent_id: resolvedAgentId,
    conversation_id: resolvedConversationId,
  };
}
