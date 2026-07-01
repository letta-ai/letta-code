import { describe, expect, test } from "bun:test";
import type { Message } from "@letta-ai/letta-client/resources/agents/messages";
import type { Backend, ConversationMessageListBody } from "@/backend";
import { createModConversationHandle } from "@/mods/conversation-handle";

const sendMessageStream = async () => (async function* () {})();

describe("mod conversation handle", () => {
  test("uses the internal backend directly for scoped fork and history", async () => {
    const calls: string[] = [];
    const newestFirstMessages = [
      { id: "message-2" },
      { id: "message-1" },
    ] as unknown as Message[];
    const backend = {
      forkConversation: async (
        ...[conversationId, options]: Parameters<Backend["forkConversation"]>
      ) => {
        calls.push(
          `fork:${conversationId}:${options?.agentId}:${options?.hidden}`,
        );
        return { id: "forked-conversation" };
      },
      listConversationMessages: async (
        conversationId: string,
        body?: ConversationMessageListBody,
      ) => {
        calls.push(
          `history:${conversationId}:${body?.agent_id}:${body?.limit}:${body?.order}:${body?.include_err}`,
        );
        return {
          getPaginatedItems: () => newestFirstMessages,
        };
      },
    } as unknown as Backend;

    const handle = createModConversationHandle({
      agentId: "agent-1",
      backend,
      conversationId: null,
      sendMessageStream,
      workingDirectory: "/tmp/project",
    });

    const forked = await handle.fork({ hidden: true });
    const history = await handle.getHistory({ limit: 2 });

    expect(forked.id).toBe("forked-conversation");
    expect(history.map((message) => message.id)).toEqual([
      "message-1",
      "message-2",
    ]);
    expect(calls).toEqual([
      "fork:default:agent-1:true",
      "history:default:agent-1:2:desc:true",
    ]);
  });

  test("throws a scoped error when no backend is available", () => {
    const handle = createModConversationHandle({
      conversationId: "conversation-1",
      sendMessageStream,
    });

    expect(() => handle.getHistory()).toThrow(
      "Mod conversation backend is not available",
    );
  });

  test("updateLlmConfig defaults to conversation scope", async () => {
    const calls: Array<{ kind: string; id: string; body: unknown }> = [];
    const backend = {
      capabilities: { localModelCatalog: false },
      updateConversation: async (id: string, body: unknown) => {
        calls.push({ kind: "conversation", id, body });
        return {};
      },
      updateAgent: async (id: string, body: unknown) => {
        calls.push({ kind: "agent", id, body });
        return {};
      },
    } as unknown as Backend;

    const handle = createModConversationHandle({
      agentId: "agent-1",
      backend,
      conversationId: "conversation-1",
      sendMessageStream,
    });

    await handle.updateLlmConfig({ contextWindow: 200000 });

    expect(calls).toEqual([
      {
        kind: "conversation",
        id: "conversation-1",
        body: { context_window_limit: 200000 },
      },
    ]);
  });

  test("updateLlmConfig with agent scope routes to the agent", async () => {
    const calls: Array<{ kind: string; id: string }> = [];
    const backend = {
      capabilities: { localModelCatalog: false },
      updateConversation: async (id: string) => {
        calls.push({ kind: "conversation", id });
        return {};
      },
      updateAgent: async (id: string) => {
        calls.push({ kind: "agent", id });
        return {};
      },
    } as unknown as Backend;

    const handle = createModConversationHandle({
      agentId: "agent-1",
      backend,
      conversationId: "conversation-1",
      sendMessageStream,
    });

    await handle.updateLlmConfig({ scope: "agent", contextWindow: 123000 });

    expect(calls).toEqual([{ kind: "agent", id: "agent-1" }]);
  });

  test("updateLlmConfig agent scope throws when agentId is unavailable", async () => {
    const backend = {
      capabilities: { localModelCatalog: false },
      updateAgent: async () => ({}),
    } as unknown as Backend;

    const handle = createModConversationHandle({
      backend,
      conversationId: "conversation-1",
      sendMessageStream,
    });

    await expect(
      handle.updateLlmConfig({ scope: "agent", contextWindow: 1000 }),
    ).rejects.toThrow("agentId is not available");
  });
});
