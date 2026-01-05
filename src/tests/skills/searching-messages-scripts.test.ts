/**
 * Tests for the bundled searching-messages scripts
 */

import { describe, expect, mock, test } from "bun:test";
import type Letta from "@letta-ai/letta-client";
import { getMessages } from "../../skills/builtin/searching-messages/scripts/get-messages";
import { searchMessages } from "../../skills/builtin/searching-messages/scripts/search-messages";

// Mock data for search results
const mockSearchResponse = [
  {
    message_type: "assistant_message",
    content: "This is a test message about flicker",
    message_id: "message-123",
    agent_id: "agent-456",
    created_at: "2025-12-31T03:09:59.273101Z",
  },
  {
    message_type: "user_message",
    content: "Do you remember when we discussed flicker?",
    message_id: "message-789",
    agent_id: "agent-456",
    created_at: "2025-12-31T03:08:00.000000Z",
  },
];

// Mock data for messages list
const mockMessagesResponse = {
  items: [
    {
      id: "message-001",
      date: "2025-12-31T03:10:00+00:00",
      message_type: "user_message",
      content: "First message",
    },
    {
      id: "message-002",
      date: "2025-12-31T03:11:00+00:00",
      message_type: "assistant_message",
      content: "Second message",
    },
  ],
};

describe("search-messages", () => {
  test("calls client.messages.search with query and defaults", async () => {
    const mockSearch = mock(() => Promise.resolve(mockSearchResponse));
    const mockClient = {
      messages: {
        search: mockSearch,
      },
    } as unknown as Letta;

    const result = await searchMessages(mockClient, {
      query: "flicker",
      agentId: "agent-456",
    });

    expect(mockSearch).toHaveBeenCalledWith({
      query: "flicker",
      agent_id: "agent-456",
      search_mode: "hybrid",
      start_date: undefined,
      end_date: undefined,
      limit: 10,
    });
    expect(result).toBeDefined();
    expect(result).toHaveLength(2);
  });

  test("passes search mode option", async () => {
    const mockSearch = mock(() => Promise.resolve(mockSearchResponse));
    const mockClient = {
      messages: {
        search: mockSearch,
      },
    } as unknown as Letta;

    await searchMessages(mockClient, {
      query: "test",
      mode: "vector",
      agentId: "agent-456",
    });

    expect(mockSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        search_mode: "vector",
      }),
    );
  });

  test("passes date filters", async () => {
    const mockSearch = mock(() => Promise.resolve(mockSearchResponse));
    const mockClient = {
      messages: {
        search: mockSearch,
      },
    } as unknown as Letta;

    await searchMessages(mockClient, {
      query: "test",
      startDate: "2025-12-31T00:00:00Z",
      endDate: "2025-12-31T23:59:59Z",
      agentId: "agent-456",
    });

    expect(mockSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        start_date: "2025-12-31T00:00:00Z",
        end_date: "2025-12-31T23:59:59Z",
      }),
    );
  });

  test("omits agent_id when allAgents is true", async () => {
    const mockSearch = mock(() => Promise.resolve(mockSearchResponse));
    const mockClient = {
      messages: {
        search: mockSearch,
      },
    } as unknown as Letta;

    await searchMessages(mockClient, {
      query: "test",
      allAgents: true,
    });

    expect(mockSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        agent_id: undefined,
      }),
    );
  });

  test("respects custom limit", async () => {
    const mockSearch = mock(() => Promise.resolve(mockSearchResponse));
    const mockClient = {
      messages: {
        search: mockSearch,
      },
    } as unknown as Letta;

    await searchMessages(mockClient, {
      query: "test",
      limit: 5,
      agentId: "agent-456",
    });

    expect(mockSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 5,
      }),
    );
  });

  test("handles empty results", async () => {
    const mockClient = {
      messages: {
        search: mock(() => Promise.resolve([])),
      },
    } as unknown as Letta;

    const result = await searchMessages(mockClient, {
      query: "nonexistent",
      agentId: "agent-456",
    });
    expect(result).toBeDefined();
    expect(result).toHaveLength(0);
  });

  test("propagates API errors", async () => {
    const mockClient = {
      messages: {
        search: mock(() => Promise.reject(new Error("API Error"))),
      },
    } as unknown as Letta;

    await expect(
      searchMessages(mockClient, { query: "test", agentId: "agent-456" }),
    ).rejects.toThrow("API Error");
  });
});

describe("get-messages", () => {
  test("calls client.agents.messages.list with defaults", async () => {
    const mockList = mock(() => Promise.resolve(mockMessagesResponse));
    const mockClient = {
      agents: {
        messages: {
          list: mockList,
        },
      },
    } as unknown as Letta;

    const result = await getMessages(mockClient, { agentId: "agent-456" });

    expect(mockList).toHaveBeenCalledWith("agent-456", {
      limit: 20,
      after: undefined,
      before: undefined,
      order: undefined,
    });
    expect(result).toBeDefined();
  });

  test("passes after cursor", async () => {
    const mockList = mock(() => Promise.resolve(mockMessagesResponse));
    const mockClient = {
      agents: {
        messages: {
          list: mockList,
        },
      },
    } as unknown as Letta;

    await getMessages(mockClient, {
      agentId: "agent-456",
      after: "message-123",
    });

    expect(mockList).toHaveBeenCalledWith(
      "agent-456",
      expect.objectContaining({
        after: "message-123",
      }),
    );
  });

  test("passes before cursor", async () => {
    const mockList = mock(() => Promise.resolve(mockMessagesResponse));
    const mockClient = {
      agents: {
        messages: {
          list: mockList,
        },
      },
    } as unknown as Letta;

    await getMessages(mockClient, {
      agentId: "agent-456",
      before: "message-789",
    });

    expect(mockList).toHaveBeenCalledWith(
      "agent-456",
      expect.objectContaining({
        before: "message-789",
      }),
    );
  });

  test("passes order option", async () => {
    const mockList = mock(() => Promise.resolve(mockMessagesResponse));
    const mockClient = {
      agents: {
        messages: {
          list: mockList,
        },
      },
    } as unknown as Letta;

    await getMessages(mockClient, {
      agentId: "agent-456",
      order: "asc",
    });

    expect(mockList).toHaveBeenCalledWith(
      "agent-456",
      expect.objectContaining({
        order: "asc",
      }),
    );
  });

  test("respects custom limit", async () => {
    const mockList = mock(() => Promise.resolve(mockMessagesResponse));
    const mockClient = {
      agents: {
        messages: {
          list: mockList,
        },
      },
    } as unknown as Letta;

    await getMessages(mockClient, {
      agentId: "agent-456",
      limit: 50,
    });

    expect(mockList).toHaveBeenCalledWith(
      "agent-456",
      expect.objectContaining({
        limit: 50,
      }),
    );
  });

  test("filters by date range client-side", async () => {
    const mockList = mock(() =>
      Promise.resolve({
        items: [
          {
            id: "msg-1",
            date: "2025-12-30T12:00:00Z",
            message_type: "user_message",
          },
          {
            id: "msg-2",
            date: "2025-12-31T12:00:00Z",
            message_type: "user_message",
          },
          {
            id: "msg-3",
            date: "2026-01-01T12:00:00Z",
            message_type: "user_message",
          },
        ],
      }),
    );
    const mockClient = {
      agents: {
        messages: {
          list: mockList,
        },
      },
    } as unknown as Letta;

    const result = await getMessages(mockClient, {
      agentId: "agent-456",
      startDate: "2025-12-31T00:00:00Z",
      endDate: "2025-12-31T23:59:59Z",
    });

    // Should filter to only the message from Dec 31
    expect(result).toHaveLength(1);
    expect((result[0] as { id: string }).id).toBe("msg-2");
  });

  test("sorts results chronologically", async () => {
    const mockList = mock(() =>
      Promise.resolve({
        items: [
          {
            id: "msg-2",
            date: "2025-12-31T14:00:00Z",
            message_type: "user_message",
          },
          {
            id: "msg-1",
            date: "2025-12-31T12:00:00Z",
            message_type: "user_message",
          },
        ],
      }),
    );
    const mockClient = {
      agents: {
        messages: {
          list: mockList,
        },
      },
    } as unknown as Letta;

    const result = await getMessages(mockClient, { agentId: "agent-456" });

    // Should be sorted oldest first
    expect((result[0] as { id: string }).id).toBe("msg-1");
    expect((result[1] as { id: string }).id).toBe("msg-2");
  });

  test("handles empty results", async () => {
    const mockClient = {
      agents: {
        messages: {
          list: mock(() => Promise.resolve({ items: [] })),
        },
      },
    } as unknown as Letta;

    const result = await getMessages(mockClient, { agentId: "agent-456" });
    expect(result).toBeDefined();
    expect(result).toHaveLength(0);
  });

  test("propagates API errors", async () => {
    const mockClient = {
      agents: {
        messages: {
          list: mock(() => Promise.reject(new Error("API Error"))),
        },
      },
    } as unknown as Letta;

    await expect(
      getMessages(mockClient, { agentId: "agent-456" }),
    ).rejects.toThrow("API Error");
  });
});
