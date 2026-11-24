import type { ConversationCreateBody } from "@/backend/backend";
import { SUBAGENT_SUMMARY_ENV } from "@/utils/subagent-launch-marker";

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
  const summary = process.env[SUBAGENT_SUMMARY_ENV]?.trim();
  const body: ConversationCreateBody & {
    parent_conversation_id: string;
    is_subagent: boolean;
  } = {
    agent_id: agentId,
    parent_conversation_id: parentConversationId,
    is_subagent: true,
    ...(summary ? { summary } : {}),
  };
  return (await create(body)).id;
}
