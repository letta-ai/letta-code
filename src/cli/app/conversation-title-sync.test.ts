import { describe, expect, test } from "bun:test";
import { publishConversationTitleChange } from "@/mods/conversation-title-events";
import { subscribeToActiveConversationTitle } from "./conversation-title-sync";

describe("active conversation title sync", () => {
  test("applies title changes only to the active conversation", () => {
    let activeConversationId: string | null = "conversation-1";
    const titles: string[] = [];
    const unsubscribe = subscribeToActiveConversationTitle({
      getActiveConversationId: () => activeConversationId,
      onTitleChange: (title) => titles.push(title),
    });

    publishConversationTitleChange({
      conversationId: "conversation-2",
      title: "Other work",
    });
    publishConversationTitleChange({
      conversationId: "conversation-1",
      title: "Current work",
    });
    activeConversationId = "conversation-2";
    publishConversationTitleChange({
      conversationId: "conversation-2",
      title: "New current work",
    });
    unsubscribe();
    publishConversationTitleChange({
      conversationId: "conversation-2",
      title: "Ignored after cleanup",
    });

    expect(titles).toEqual(["Current work", "New current work"]);
  });
});
