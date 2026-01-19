/**
 * Tests for the bundled messaging-agents scripts
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type Letta from "@letta-ai/letta-client";
import { continueConversation } from "../../skills/builtin/messaging-agents/scripts/continue-conversation";
import { startConversation } from "../../skills/builtin/messaging-agents/scripts/start-conversation";

// Mock agent data
const mockSenderAgent = {
  id: "agent-sender-123",
  name: "SenderAgent",
};

const mockTargetAgent = {
  id: "agent-target-456",
  name: "TargetAgent",
};

const mockConversation = {
  id: "conversation-789",
  agent_id: mockTargetAgent.id,
};

// Helper to create a mock async iterator for streaming
function createMockStream(
  chunks: Array<{ message_type: string; content?: string }>,
) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  };
}

describe("start-conversation", () => {
  const originalEnv = process.env.LETTA_AGENT_ID;

  beforeEach(() => {
    process.env.LETTA_AGENT_ID = mockSenderAgent.id;
  });

  afterEach(() => {
    if (originalEnv) {
      process.env.LETTA_AGENT_ID = originalEnv;
    } else {
      delete process.env.LETTA_AGENT_ID;
    }
  });

  test("creates conversation and sends message with system reminder", async () => {
    const mockRetrieve = mock((id: string) => {
      if (id === mockSenderAgent.id) return Promise.resolve(mockSenderAgent);
      if (id === mockTargetAgent.id) return Promise.resolve(mockTargetAgent);
      throw new Error(`Unknown agent: ${id}`);
    });

    const mockCreate = mock(() => Promise.resolve(mockConversation));

    const mockMessageCreate = mock(() =>
      Promise.resolve(
        createMockStream([
          { message_type: "reasoning_message", content: "thinking..." },
          { message_type: "assistant_message", content: "Hello there!" },
        ]),
      ),
    );

    const mockClient = {
      agents: {
        retrieve: mockRetrieve,
      },
      conversations: {
        create: mockCreate,
        messages: {
          create: mockMessageCreate,
        },
      },
    } as unknown as Letta;

    const result = await startConversation(mockClient, {
      agentId: mockTargetAgent.id,
      message: "Hello!",
    });

    // Check that target agent was fetched
    expect(mockRetrieve).toHaveBeenCalledWith(mockTargetAgent.id);
    // Check that sender agent was fetched
    expect(mockRetrieve).toHaveBeenCalledWith(mockSenderAgent.id);

    // Check conversation was created
    expect(mockCreate).toHaveBeenCalledWith({
      agent_id: mockTargetAgent.id,
    });

    // Check message was sent with system reminder
    expect(mockMessageCreate).toHaveBeenCalledWith(mockConversation.id, {
      input: expect.stringContaining("<system-reminder>"),
    });
    expect(mockMessageCreate).toHaveBeenCalledWith(mockConversation.id, {
      input: expect.stringContaining("Hello!"),
    });
    expect(mockMessageCreate).toHaveBeenCalledWith(mockConversation.id, {
      input: expect.stringContaining(mockSenderAgent.name),
    });

    // Check result
    expect(result.conversation_id).toBe(mockConversation.id);
    expect(result.response).toBe("Hello there!");
    expect(result.agent_id).toBe(mockTargetAgent.id);
    expect(result.agent_name).toBe(mockTargetAgent.name);
  });

  test("throws error when target agent not found", async () => {
    const mockClient = {
      agents: {
        retrieve: mock(() => Promise.reject(new Error("Agent not found"))),
      },
      conversations: {
        create: mock(),
        messages: { create: mock() },
      },
    } as unknown as Letta;

    await expect(
      startConversation(mockClient, {
        agentId: "nonexistent",
        message: "Hello!",
      }),
    ).rejects.toThrow("Agent not found");
  });

  test("throws error when LETTA_AGENT_ID not set", async () => {
    delete process.env.LETTA_AGENT_ID;

    const mockClient = {
      agents: {
        retrieve: mock(() => Promise.resolve(mockTargetAgent)),
      },
      conversations: {
        create: mock(),
        messages: { create: mock() },
      },
    } as unknown as Letta;

    await expect(
      startConversation(mockClient, {
        agentId: mockTargetAgent.id,
        message: "Hello!",
      }),
    ).rejects.toThrow("LETTA_AGENT_ID");
  });
});

describe("continue-conversation", () => {
  const originalEnv = process.env.LETTA_AGENT_ID;

  beforeEach(() => {
    process.env.LETTA_AGENT_ID = mockSenderAgent.id;
  });

  afterEach(() => {
    if (originalEnv) {
      process.env.LETTA_AGENT_ID = originalEnv;
    } else {
      delete process.env.LETTA_AGENT_ID;
    }
  });

  test("continues existing conversation with system reminder", async () => {
    const mockAgentRetrieve = mock((id: string) => {
      if (id === mockSenderAgent.id) return Promise.resolve(mockSenderAgent);
      if (id === mockTargetAgent.id) return Promise.resolve(mockTargetAgent);
      throw new Error(`Unknown agent: ${id}`);
    });

    const mockConversationRetrieve = mock(() =>
      Promise.resolve(mockConversation),
    );

    const mockMessageCreate = mock(() =>
      Promise.resolve(
        createMockStream([
          { message_type: "assistant_message", content: "Follow-up response!" },
        ]),
      ),
    );

    const mockClient = {
      agents: {
        retrieve: mockAgentRetrieve,
      },
      conversations: {
        retrieve: mockConversationRetrieve,
        messages: {
          create: mockMessageCreate,
        },
      },
    } as unknown as Letta;

    const result = await continueConversation(mockClient, {
      conversationId: mockConversation.id,
      message: "Follow-up question",
    });

    // Check conversation was fetched
    expect(mockConversationRetrieve).toHaveBeenCalledWith(mockConversation.id);

    // Check target agent was fetched
    expect(mockAgentRetrieve).toHaveBeenCalledWith(mockTargetAgent.id);

    // Check sender agent was fetched
    expect(mockAgentRetrieve).toHaveBeenCalledWith(mockSenderAgent.id);

    // Check message was sent with system reminder
    expect(mockMessageCreate).toHaveBeenCalledWith(mockConversation.id, {
      input: expect.stringContaining("<system-reminder>"),
    });
    expect(mockMessageCreate).toHaveBeenCalledWith(mockConversation.id, {
      input: expect.stringContaining("Follow-up question"),
    });

    // Check result
    expect(result.conversation_id).toBe(mockConversation.id);
    expect(result.response).toBe("Follow-up response!");
    expect(result.agent_id).toBe(mockTargetAgent.id);
    expect(result.agent_name).toBe(mockTargetAgent.name);
  });

  test("throws error when conversation not found", async () => {
    const mockClient = {
      agents: {
        retrieve: mock(),
      },
      conversations: {
        retrieve: mock(() =>
          Promise.reject(new Error("Conversation not found")),
        ),
        messages: { create: mock() },
      },
    } as unknown as Letta;

    await expect(
      continueConversation(mockClient, {
        conversationId: "nonexistent",
        message: "Hello!",
      }),
    ).rejects.toThrow("Conversation not found");
  });

  test("handles empty response from agent", async () => {
    const mockAgentRetrieve = mock((id: string) => {
      if (id === mockSenderAgent.id) return Promise.resolve(mockSenderAgent);
      if (id === mockTargetAgent.id) return Promise.resolve(mockTargetAgent);
      throw new Error(`Unknown agent: ${id}`);
    });

    const mockConversationRetrieve = mock(() =>
      Promise.resolve(mockConversation),
    );

    const mockMessageCreate = mock(() =>
      Promise.resolve(
        createMockStream([
          { message_type: "reasoning_message", content: "thinking..." },
          // No assistant message - agent didn't respond with text
        ]),
      ),
    );

    const mockClient = {
      agents: {
        retrieve: mockAgentRetrieve,
      },
      conversations: {
        retrieve: mockConversationRetrieve,
        messages: {
          create: mockMessageCreate,
        },
      },
    } as unknown as Letta;

    const result = await continueConversation(mockClient, {
      conversationId: mockConversation.id,
      message: "Hello?",
    });

    expect(result.response).toBe("");
  });
});
