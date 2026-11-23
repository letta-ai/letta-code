import type { ConversationCreateBody } from "@/backend/backend";

export async function createSubagentConversation(
  cloudBackend: boolean,
  parentConversationId: string | undefined,
  agentId: string,
  create: (body: ConversationCreateBody) => Promise<{ id: string }>,
): Promise<string> {
  if (
    !cloudBackend ||
    !parentConversationId ||
    parentConversationId === "default"
  ) {
    return "default";
  }
  const body: ConversationCreateBody & {
    parent_conversation_id: string;
    is_subagent: boolean;
  } = {
    agent_id: agentId,
    parent_conversation_id: parentConversationId,
    is_subagent: true,
  };
  return (await create(body)).id;
}
