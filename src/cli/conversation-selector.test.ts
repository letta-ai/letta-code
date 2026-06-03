import { describe, expect, test } from "bun:test";
import type { Conversation } from "@letta-ai/letta-client/resources/conversations/conversations";
import {
  buildConversationSelectorHints,
  buildDefaultConversationEntry,
  formatConversationTimestampText,
  isConversationPinned,
  mergePinnedConversationRecords,
} from "@/cli/components/ConversationSelector";

describe("ConversationSelector timestamps", () => {
  test("does not invent a creation time for the default conversation", () => {
    const lastActiveAt = new Date(
      Date.now() - 8 * 24 * 60 * 60 * 1000,
    ).toISOString();

    const entry = buildDefaultConversationEntry("agent-1", {
      previewLines: [],
      lastActiveAt,
      messageCount: 3,
    });

    expect(entry.conversation.id).toBe("default");
    expect(entry.conversation.created_at).toBeNull();
    expect(entry.conversation.updated_at).toBe(lastActiveAt);
    expect(entry.lastActiveAt).toBe(lastActiveAt);
  });

  test("uses real default conversation creation time when available", () => {
    const createdAt = new Date(
      Date.now() - 8 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const lastActiveAt = new Date(
      Date.now() - 2 * 60 * 60 * 1000,
    ).toISOString();

    const entry = buildDefaultConversationEntry(
      "agent-1",
      {
        previewLines: [],
        lastActiveAt,
        messageCount: 3,
      },
      createdAt,
    );

    expect(entry.conversation.created_at).toBe(createdAt);
    expect(entry.conversation.updated_at).toBe(lastActiveAt);
  });

  test("suppresses impossible created-after-active timelines", () => {
    const lastActiveAt = new Date(
      Date.now() - 8 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const createdAt = new Date().toISOString();

    const text = formatConversationTimestampText({ lastActiveAt, createdAt });

    expect(text).toContain("Active 1 week ago");
    expect(text).not.toContain("Created");
  });

  test("shows creation time when the timeline is valid", () => {
    const createdAt = new Date(
      Date.now() - 8 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const lastActiveAt = new Date(
      Date.now() - 2 * 60 * 60 * 1000,
    ).toISOString();

    const text = formatConversationTimestampText({ lastActiveAt, createdAt });

    expect(text).toContain("Active 2 hours ago");
    expect(text).toContain("Created 1 week ago");
  });
});

describe("ConversationSelector pinned conversations", () => {
  test("hides the pin shortcut hint when default conversation is selected", () => {
    expect(
      buildConversationSelectorHints({ isSelectedDefaultConversation: true }),
    ).not.toContain("Alt+P");
    expect(
      buildConversationSelectorHints({ isSelectedDefaultConversation: false }),
    ).toContain("Alt+P pin/unpin");
  });

  test("treats the default conversation as permanently pinned", () => {
    expect(
      isConversationPinned({
        conversationId: "default",
        pinnedIds: new Set(),
      }),
    ).toBe(true);
  });

  test("uses stored pin state for non-default conversations", () => {
    const pinnedIds = new Set(["conv-pinned"]);

    expect(
      isConversationPinned({ conversationId: "conv-pinned", pinnedIds }),
    ).toBe(true);
    expect(
      isConversationPinned({ conversationId: "conv-unpinned", pinnedIds }),
    ).toBe(false);
  });

  test("includes pinned conversations missing from the recent page", () => {
    const listed = [{ id: "recent-1" }, { id: "recent-2" }] as Conversation[];
    const pinned = [{ id: "old-pinned" }] as Conversation[];

    expect(
      mergePinnedConversationRecords(listed, pinned).map((c) => c.id),
    ).toEqual(["old-pinned", "recent-1", "recent-2"]);
  });

  test("does not duplicate pinned conversations already in the recent page", () => {
    const listed = [{ id: "recent-1" }, { id: "old-pinned" }] as Conversation[];
    const pinned = [{ id: "old-pinned" }] as Conversation[];

    expect(
      mergePinnedConversationRecords(listed, pinned).map((c) => c.id),
    ).toEqual(["recent-1", "old-pinned"]);
  });
});
