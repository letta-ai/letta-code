/**
 * Pure routing function for the list_messages control request.
 *
 * Extracted from headless.ts so it can be tested in isolation without
 * spinning up a real Letta client.
 *
 * All paths now use the conversations endpoint. For the default conversation,
 * the agent ID is passed as the conversation_id (the server accepts agent-*
 * IDs for agent-direct messaging).
 */

import type { ListMessagesControlRequest } from "../types/protocol";

export type ListMessagesRoute = {
  kind: "conversations";
  conversationId: string;
};

/**
 * Resolve which Letta API endpoint to call for a list_messages request.
 *
 * @param listReq      The inbound control request (partial — only conv/agent id used)
 * @param sessionConvId  The session's current conversationId (already resolved
 *                       at session init, either "default" or a real conv id)
 * @param sessionAgentId The session's agentId (fallback when using agents path)
 */
export function resolveListMessagesRoute(
  listReq: Pick<ListMessagesControlRequest, "conversation_id" | "agent_id">,
  sessionConvId: string,
  sessionAgentId: string,
): ListMessagesRoute {
  const targetConvId = listReq.conversation_id ?? sessionConvId;

  if (targetConvId !== "default") {
    return { kind: "conversations", conversationId: targetConvId };
  }

  // Default conversation: pass the agent ID to the conversations endpoint.
  // The server accepts agent-* IDs for agent-direct messaging.
  const agentId = listReq.agent_id ?? sessionAgentId;
  return { kind: "conversations", conversationId: agentId };
}
