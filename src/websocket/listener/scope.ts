import type { RuntimeScope } from "../../types/protocol_v2";
import type { ListenerRuntime } from "./types";

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
  return (
    normalizeCwdAgentId(params?.agent_id) ?? runtime?.activeAgentId ?? null
  );
}

export function resolveScopedConversationId(
  runtime: ListenerRuntime | null,
  params?: {
    conversation_id?: string | null;
  },
): string {
  return normalizeConversationId(
    params?.conversation_id ?? runtime?.activeConversationId,
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

export function isScopeCurrentlyActive(
  runtime: ListenerRuntime,
  agentId: string | null,
  conversationId: string,
): boolean {
  if (!runtime.isProcessing) return true;

  const activeAgent = runtime.activeAgentId;
  const activeConvo = normalizeConversationId(runtime.activeConversationId);

  if (agentId && activeAgent && agentId !== activeAgent) return false;
  if (conversationId !== activeConvo) return false;

  return true;
}
