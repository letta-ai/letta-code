/**
 * Pure routing function for the list_messages control request.
 *
 * Extracted from headless.ts so it can be tested in isolation without
 * spinning up a real Letta client.
 *
 * All paths use the conversations endpoint. For the default conversation,
 * conversation_id stays "default" and agent_id is passed as query param.
 */

import type { ListMessagesControlRequest } from "../types/protocol";

export type ListMessagesRoute = {
  kind: "conversations";
  conversationId: string;
  agentId?: string;
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

  // Default conversation: keep conversation_id as "default" and
  // pass the agent ID as a query parameter.
  const agentId = listReq.agent_id ?? sessionAgentId;
  return { kind: "conversations", conversationId: "default", agentId };
}
