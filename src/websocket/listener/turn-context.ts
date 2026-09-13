import {
  getConversationId,
  getCurrentAgentId,
  setConversationId,
  setCurrentAgentId,
} from "@/agent/context";
import type { ConversationRuntime } from "./types";

export function releaseListenerTurnContext(params: {
  runtime: ConversationRuntime;
  agentId?: string | null;
  conversationId: string;
}): void {
  const { runtime, agentId, conversationId } = params;
  if (runtime.turnLifecycle.kind !== "idle") {
    return;
  }

  try {
    const currentConversationId = getConversationId();
    let currentAgentId: string | null = null;
    try {
      currentAgentId = getCurrentAgentId();
    } catch {
      currentAgentId = null;
    }

    if (
      currentAgentId === (agentId ?? null) &&
      currentConversationId === conversationId
    ) {
      setCurrentAgentId(null);
      setConversationId(null);
    }
  } catch {
    // Best-effort cleanup only. Never let teardown obscure the turn result.
  }
}
