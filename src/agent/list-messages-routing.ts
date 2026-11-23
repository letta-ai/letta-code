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
