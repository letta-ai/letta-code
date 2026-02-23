/**
 * Pure routing function for the list_messages control request.
 *
 * Extracted from headless.ts so it can be tested in isolation without
 * spinning up a real Letta client.
 *
 * Routing rules (in priority order):
 * 1. Explicit `conversation_id` in the request → conversations.messages.list
 * 2. Session is on a named conversation (not "default") → conversations.messages.list
 * 3. Session is on the default conversation → agents.messages.list
 */

import type { ListMessagesControlRequest } from "../types/protocol";

export type ListMessagesRoute =
  | { kind: "conversations"; conversationId: string }
  | { kind: "agents"; agentId: string };

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

  // Session is on the agent's default conversation —
  // use request's agent_id if supplied (e.g. explicit override), else session's
  return { kind: "agents", agentId: listReq.agent_id ?? sessionAgentId };
}
