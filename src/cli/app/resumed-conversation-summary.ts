type ConversationWithSummary = {
  summary?: string | null;
};

export function resolveResumedConversationSummary(
  conversation: ConversationWithSummary | null | undefined,
  selectorSummary?: string | null,
): string | undefined {
  return selectorSummary ?? (conversation?.summary?.trim() || undefined);
}
