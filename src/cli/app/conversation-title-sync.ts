import { useEffect } from "react";
import { subscribeToConversationTitleChanges } from "@/mods/conversation-title-events";

export function useConversationTitleSync(
  conversationId: string,
  onTitleChange: (title: string) => void,
): void {
  useEffect(
    () =>
      subscribeToActiveConversationTitle({
        getActiveConversationId: () => conversationId,
        onTitleChange,
      }),
    [conversationId, onTitleChange],
  );
}

export function subscribeToActiveConversationTitle(options: {
  getActiveConversationId: () => string | null;
  onTitleChange: (title: string) => void;
}): () => void {
  return subscribeToConversationTitleChanges((change) => {
    if (change.conversationId === options.getActiveConversationId()) {
      options.onTitleChange(change.title);
    }
  });
}
