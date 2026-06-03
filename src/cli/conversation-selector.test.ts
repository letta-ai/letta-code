import { describe, expect, test } from "bun:test";
import type { Conversation } from "@letta-ai/letta-client/resources/conversations/conversations";
import {
  buildDefaultConversationEntry,
  formatConversationTimestampText,
  mergePinnedConversationRecords,
  searchConversationTitlesForSelector,
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

describe("ConversationSelector title search", () => {
  test("uses backend conversation search and dedupes title matches", async () => {
    const listCalls: unknown[] = [];
    const backend = {
      capabilities: { localModelCatalog: true },
      listConversations: async (body: unknown) => {
        listCalls.push(body);
        return [
          { id: "conv-1", summary: "TUI title search" },
          { id: "conv-1", summary: "TUI title search" },
          { id: "conv-2", summary: "Unrelated" },
        ] as Conversation[];
      },
    };

    const results = await searchConversationTitlesForSelector({
      agentId: "agent-1",
      query: "title search",
      backend: backend as never,
      limit: 10,
    });

    expect(results.map((conversation) => conversation.id)).toEqual(["conv-1"]);
    expect(listCalls).toEqual([
      {
        agent_id: "agent-1",
        limit: 10,
        order: "desc",
        order_by: "last_message_at",
      },
    ]);
  });

  test("does not search blank queries", async () => {
    const backend = {
      capabilities: { localModelCatalog: true },
      listConversations: async () => {
        throw new Error("should not list conversations");
      },
    };

    await expect(
      searchConversationTitlesForSelector({
        agentId: "agent-1",
        query: "   ",
        backend: backend as never,
      }),
    ).resolves.toEqual([]);
  });
});
