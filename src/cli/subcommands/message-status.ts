import type { Backend } from "@/backend";
import { getAgentRuntimeStatus } from "@/backend/api/agents";
import { getLatestConversationSuperRun } from "@/backend/api/conversation-enqueue";
import { ApiRequestError } from "@/backend/api/request";

/** Inspection works for any readable conversation, without a local Task ID. */
export async function readMessageStatus(
  conversationId: string,
  agentId: string | undefined,
  backend: Pick<Backend, "capabilities" | "retrieveConversation">,
  deps = { getAgentRuntimeStatus, getLatestConversationSuperRun },
): Promise<object> {
  if (!backend.capabilities.environmentRouting)
    throw new Error(
      "Message status is only available for Cloud conversations.",
    );
  if (conversationId !== "default") {
    const conversation = await backend.retrieveConversation(conversationId);
    if (agentId && conversation.agent_id !== agentId)
      throw new Error("The conversation does not belong to that agent.");
    agentId = conversation.agent_id ?? undefined;
  }
  if (!agentId) throw new Error("--conversation default requires --agent.");
  const runtime = await deps.getAgentRuntimeStatus(agentId, [conversationId]);
  let latest = null;
  if (conversationId !== "default") {
    try {
      latest = await deps.getLatestConversationSuperRun(conversationId);
    } catch (error) {
      if (!(error instanceof ApiRequestError && error.status === 404))
        throw error;
    }
  }
  return {
    agent_id: agentId,
    conversation_id: conversationId,
    runtime_status:
      runtime.statuses.find(
        (status) => status.conversation_id === conversationId,
      ) ?? null,
    latest_super_run: latest,
    note: "This is the conversation's current state, not confirmation that a particular message completed. Compare latest_super_run.id with your receipt; a different ID belongs to a different send. Use messages list to inspect the conversation.",
  };
}
