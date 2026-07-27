import { describe, expect, mock, test } from "bun:test";
import type { Backend } from "@/backend";
import { listConversationMessagePage } from "@/websocket/listener/commands/agents-conversations";

type MessageBackend = Pick<Backend, "listConversationMessages">;

function page(messages: unknown[]) {
  return { getPaginatedItems: () => messages };
}

function backendWithPages(...pages: unknown[][]): {
  backend: MessageBackend;
  listMessages: ReturnType<typeof mock>;
} {
  const listMessages = mock(async () => page(pages.shift() ?? []));
  return {
    backend: {
      listConversationMessages:
        listMessages as unknown as MessageBackend["listConversationMessages"],
    },
    listMessages,
  };
}

describe("listConversationMessagePage", () => {
  test("returns a partial final page without probing", async () => {
    const { backend, listMessages } = backendWithPages([
      { id: "message-3" },
      { id: "message-2" },
    ]);

    const result = await listConversationMessagePage(backend, "conv-1", {
      order: "desc",
      limit: 3,
    });

    expect(result).toEqual({
      messages: [{ id: "message-3" }, { id: "message-2" }],
      nextBefore: "message-2",
      hasMore: false,
    });
    expect(listMessages).toHaveBeenCalledTimes(1);
  });

  test("trims an overfilled backend page and reports more history", async () => {
    const { backend, listMessages } = backendWithPages([
      { id: "message-4" },
      { id: "message-3" },
      { id: "message-2" },
    ]);

    const result = await listConversationMessagePage(backend, "conv-1", {
      order: "desc",
      limit: 2,
    });

    expect(result).toEqual({
      messages: [{ id: "message-4" }, { id: "message-3" }],
      nextBefore: "message-3",
      hasMore: true,
    });
    expect(listMessages).toHaveBeenCalledTimes(1);
  });

  test("probes an exactly full page with its oldest message id", async () => {
    const { backend, listMessages } = backendWithPages(
      [{ id: "message-4" }, { id: "message-3" }],
      [{ id: "message-2" }],
    );

    const result = await listConversationMessagePage(backend, "conv-1", {
      before: "message-5",
      order: "desc",
      limit: 2,
    });

    expect(result.hasMore).toBe(true);
    expect(result.nextBefore).toBe("message-3");
    expect(listMessages).toHaveBeenNthCalledWith(2, "conv-1", {
      before: "message-3",
      after: undefined,
      order: "desc",
      limit: 1,
    });
  });

  test("uses the first item as the oldest id for ascending pages", async () => {
    const { backend, listMessages } = backendWithPages(
      [{ id: "message-2" }, { id: "message-3" }],
      [],
    );

    const result = await listConversationMessagePage(backend, "conv-1", {
      order: "asc",
      limit: 2,
    });

    expect(result.nextBefore).toBe("message-2");
    expect(result.hasMore).toBe(false);
    expect(listMessages).toHaveBeenNthCalledWith(2, "conv-1", {
      before: "message-2",
      after: undefined,
      order: "desc",
      limit: 1,
    });
  });

  test("walks multiple descending pages without duplicates", async () => {
    const allMessages = Array.from({ length: 7 }, (_, index) => ({
      id: `message-${index + 1}`,
    }));
    const listMessages = mock(
      async (
        _conversationId: string,
        query: { before?: string; limit?: number },
      ) => {
        const end = query.before
          ? allMessages.findIndex((message) => message.id === query.before)
          : allMessages.length;
        const start = Math.max(0, end - (query.limit ?? 50));
        return page(allMessages.slice(start, end).reverse());
      },
    );
    const backend: MessageBackend = {
      listConversationMessages:
        listMessages as unknown as MessageBackend["listConversationMessages"],
    };
    const collected: string[] = [];
    let before: string | undefined;

    for (;;) {
      const result = await listConversationMessagePage(backend, "conv-1", {
        ...(before ? { before } : {}),
        limit: 3,
      });
      collected.push(
        ...result.messages.map((message) => (message as { id: string }).id),
      );
      if (!result.hasMore) break;
      expect(result.nextBefore).not.toBeNull();
      before = result.nextBefore ?? undefined;
    }

    expect(collected).toEqual([
      "message-7",
      "message-6",
      "message-5",
      "message-4",
      "message-3",
      "message-2",
      "message-1",
    ]);
    expect(new Set(collected).size).toBe(collected.length);
  });
});
