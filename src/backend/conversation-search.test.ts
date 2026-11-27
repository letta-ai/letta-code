import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Conversation } from "@letta-ai/letta-client/resources/conversations/conversations";
import type { Backend } from "@/backend";
import { searchConversationsForBackend } from "@/backend/conversation-search";
import { LocalBackend } from "@/backend/local/local-backend";

function conversation(input: {
  id: string;
  summary?: string;
  updatedAt: string;
}): Conversation {
  return {
    id: input.id,
    agent_id: "agent-1",
    summary: input.summary ?? null,
    created_at: input.updatedAt,
    updated_at: input.updatedAt,
    last_message_at: input.updatedAt,
  } as Conversation;
}

/**
 * A backend that mirrors the local store: conversations are ordered by
 * `last_message_at` descending, the `limit` truncates the list, and `after`
 * continues after the given conversation id.
 */
function localBackend(conversations: Conversation[]): {
  backend: Backend;
  listCalls: Array<Record<string, unknown>>;
} {
  const listCalls: Array<Record<string, unknown>> = [];
  const backend = {
    capabilities: { localModelCatalog: true },
    listConversations: async (body?: Record<string, unknown>) => {
      listCalls.push(body ?? {});
      const agentId = body?.agent_id;
      const after = body?.after;
      const limit = typeof body?.limit === "number" ? body.limit : 20;
      let filtered = conversations.filter(
        (item) => !agentId || item.agent_id === agentId,
      );
      filtered = [...filtered].sort((a, b) =>
        String(b.last_message_at ?? "").localeCompare(
          String(a.last_message_at ?? ""),
        ),
      );
      if (typeof after === "string") {
        const afterIndex = filtered.findIndex((item) => item.id === after);
        if (afterIndex >= 0) filtered = filtered.slice(afterIndex + 1);
      }
      return filtered.slice(0, limit);
    },
  } as unknown as Backend;
  return { backend, listCalls };
}

describe("searchConversationsForBackend on the local backend", () => {
  test("finds an older conversation that the result limit would have skipped", async () => {
    const conversations = [
      ...Array.from({ length: 12 }, (_, index) =>
        conversation({
          id: `recent-${index + 1}`,
          summary: `Recent conversation ${index + 1}`,
          updatedAt: `2026-07-18T12:00:${String(index).padStart(2, "0")}.000Z`,
        }),
      ),
      conversation({
        id: "older-relevant",
        summary: "OLDER_RELEVANT_7Q4M",
        updatedAt: "2026-07-01T12:00:00.000Z",
      }),
    ];
    const { backend } = localBackend(conversations);

    const results = await searchConversationsForBackend(
      { query: "OLDER_RELEVANT_7Q4M", agent_id: "agent-1", limit: 12 },
      backend,
    );

    expect(results.map((result) => result.conversation.id)).toEqual([
      "older-relevant",
    ]);
  });

  test("still returns at most the requested number of results", async () => {
    const conversations = Array.from({ length: 30 }, (_, index) =>
      conversation({
        id: `conv-${index + 1}`,
        summary: "shared token",
        updatedAt: `2026-07-18T12:00:${String(index).padStart(2, "0")}.000Z`,
      }),
    );
    const { backend } = localBackend(conversations);

    const results = await searchConversationsForBackend(
      { query: "shared", agent_id: "agent-1", limit: 5 },
      backend,
    );

    expect(results).toHaveLength(5);
  });

  test("ranks exact term matches above partial matches", async () => {
    const conversations = [
      conversation({
        id: "partial",
        summary: "mentions alpha only",
        updatedAt: "2026-07-18T12:00:02.000Z",
      }),
      conversation({
        id: "exact",
        summary: "alpha beta",
        updatedAt: "2026-07-18T12:00:01.000Z",
      }),
    ];
    const { backend } = localBackend(conversations);

    const results = await searchConversationsForBackend(
      { query: "alpha beta", agent_id: "agent-1", limit: 12 },
      backend,
    );

    expect(results.map((result) => result.conversation.id)).toEqual([
      "exact",
      "partial",
    ]);
  });

  test("does not fetch more pages once the last page is exhausted", async () => {
    const conversations = Array.from({ length: 3 }, (_, index) =>
      conversation({
        id: `conv-${index + 1}`,
        summary: "token",
        updatedAt: `2026-07-18T12:00:0${index}.000Z`,
      }),
    );
    const { backend, listCalls } = localBackend(conversations);

    await searchConversationsForBackend(
      { query: "token", agent_id: "agent-1", limit: 12 },
      backend,
    );

    expect(listCalls).toHaveLength(1);
  });

  test("fetches every page of candidates before ranking", async () => {
    const conversations = Array.from({ length: 600 }, (_, index) =>
      conversation({
        id: `conv-${index + 1}`,
        summary: index === 0 ? "needle" : `filler ${index + 1}`,
        updatedAt: `2026-07-18T12:00:${String(index % 60).padStart(2, "0")}.000Z`,
      }),
    );
    const { backend, listCalls } = localBackend(conversations);

    const results = await searchConversationsForBackend(
      { query: "needle", agent_id: "agent-1", limit: 12 },
      backend,
    );

    expect(results.map((result) => result.conversation.id)).toEqual(["conv-1"]);
    expect(listCalls.length).toBeGreaterThan(1);
  });

  test("stops paginating when the backend keeps returning the same page", async () => {
    const conversations = Array.from({ length: 3 }, (_, index) =>
      conversation({
        id: `conv-${index + 1}`,
        summary: "token",
        updatedAt: `2026-07-18T12:00:0${index}.000Z`,
      }),
    );
    const listCalls: Array<Record<string, unknown>> = [];
    const backend = {
      capabilities: { localModelCatalog: true },
      listConversations: async (body?: Record<string, unknown>) => {
        listCalls.push(body ?? {});
        // Ignores the cursor and always answers with the same full page.
        return conversations;
      },
    } as unknown as Backend;

    const results = await searchConversationsForBackend(
      { query: "token", agent_id: "agent-1", limit: 12 },
      backend,
    );

    expect(results).toHaveLength(3);
    expect(listCalls.length).toBeLessThan(10);
  });

  test("returns nothing for an empty query", async () => {
    const { backend, listCalls } = localBackend([
      conversation({
        id: "conv-1",
        summary: "token",
        updatedAt: "2026-07-18T12:00:00.000Z",
      }),
    ]);

    const results = await searchConversationsForBackend(
      { query: "   ", agent_id: "agent-1", limit: 12 },
      backend,
    );

    expect(results).toEqual([]);
    expect(listCalls).toHaveLength(0);
  });
});

describe("searchConversationsForBackend against the local store", () => {
  test("finds an older conversation that a recency-limited search would skip", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "conversation-search-"));
    try {
      const backend = new LocalBackend({ storageDir, memfsEnabled: false });
      const agent = await backend.createAgent({ name: "Local" } as never);
      // Created first, so it is the oldest conversation for this agent.
      const older = await backend.createConversation({
        agent_id: agent.id,
        summary: "OLDER_RELEVANT_7Q4M",
      } as never);
      for (let index = 0; index < 12; index++) {
        await backend.createConversation({
          agent_id: agent.id,
          summary: `Recent conversation ${index}`,
        } as never);
      }

      const results = await searchConversationsForBackend(
        { query: "OLDER_RELEVANT_7Q4M", agent_id: agent.id, limit: 12 },
        backend,
      );

      expect(results.map((result) => result.conversation.id)).toEqual([
        older.id,
      ]);
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });
});
