export interface ConversationTitleChange {
  conversationId: string;
  title: string;
}

type ConversationTitleChangeListener = (
  change: ConversationTitleChange,
) => void;

const listeners = new Set<ConversationTitleChangeListener>();

export function publishConversationTitleChange(
  change: ConversationTitleChange,
): void {
  for (const listener of listeners) {
    listener(change);
  }
}

export function subscribeToConversationTitleChanges(
  listener: ConversationTitleChangeListener,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
