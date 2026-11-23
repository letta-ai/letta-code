import { getBackend } from "@/backend";

export const DEFAULT_CONVERSATION_RENAME_ERROR =
  "The default conversation can't be renamed. Start a named one with /new <name>, or switch to another conversation first.";

export async function renameConvo(
  conversationId: string,
  summary: string,
): Promise<void> {
  if (conversationId === "default") {
    throw new Error(DEFAULT_CONVERSATION_RENAME_ERROR);
  }
  await getBackend().updateConversation(conversationId, { summary });
}
