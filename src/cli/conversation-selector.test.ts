import { describe, expect, test } from "bun:test";
import {
  buildConversationSelectorHints,
  buildDefaultConversationEntry,
  formatConversationTimestampText,
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

describe("ConversationSelector hints", () => {
  test("shows navigation hints without pin shortcuts", () => {
    expect(buildConversationSelectorHints()).toBe(
      "Enter select · ↑↓ navigate · Esc clear/cancel",
    );
  });
});
