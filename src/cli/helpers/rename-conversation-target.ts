import { getBackend } from "@/backend";

export const DEFAULT_CONVERSATION_RENAME_ERROR =
  "The default conversation can't be renamed. Start a named one with /new <name>, or switch to another conversation first.";

/**
 * Rename a conversation. The agent's default conversation is a per-agent
 * alias rather than a stored conversation, so the server has nothing to
 * rename and would return a bare 404; fail with a clear message instead.
 */
export async function renameConvo(
  conversationId: string,
  summary: string,
): Promise<void> {
  if (conversationId === "default") {
    throw new Error(DEFAULT_CONVERSATION_RENAME_ERROR);
  }
  await getBackend().updateConversation(conversationId, { summary });
}
