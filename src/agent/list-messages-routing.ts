/**
 * Pure routing function for the list_messages control request.
 *
 * Extracted from headless.ts so it can be tested in isolation without
 * spinning up a real Letta client.
 *
 * All paths use the conversations endpoint. For the default conversation,
 * conversation_id stays "default" and agent_id is passed as query param.
 */

import type { ListMessagesControlRequest } from "@/types/protocol";

export type ListMessagesRoute = {
  kind: "conversations";
  conversationId: string;
  agentId?: string;
};

export function resolveListMessagesRoute(
  listReq: Pick<ListMessagesControlRequest, "conversation_id" | "agent_id">,
  sessionConvId: string,
  sessionAgentId: string,
): ListMessagesRoute {
  const targetConvId = listReq.conversation_id ?? sessionConvId;

  if (targetConvId !== "default") {
    return { kind: "conversations", conversationId: targetConvId };
  }

  const agentId = listReq.agent_id ?? sessionAgentId;
  return { kind: "conversations", conversationId: "default", agentId };
}
