import { describe, expect, test } from "bun:test";
import type { Message } from "@letta-ai/letta-client/resources/agents/messages";
import type { Backend, ConversationMessageListBody } from "@/backend";
import { createExtensionConversationHandle } from "@/extensions/conversation-handle";

const sendMessageStream = async () => (async function* () {})();

describe("extension conversation handle", () => {
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

    const handle = createExtensionConversationHandle({
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
    const handle = createExtensionConversationHandle({
      conversationId: "conversation-1",
      sendMessageStream,
    });

    expect(() => handle.getHistory()).toThrow(
      "Extension conversation backend is not available",
    );
  });
});
