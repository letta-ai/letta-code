import { afterEach, describe, expect, test } from "bun:test";
import { createModConversationHandle } from "@/mods/conversation-handle";
import {
  type ConversationRotationHandler,
  hasConversationRotationHandler,
  registerConversationRotationHandler,
  requestConversationRotation,
} from "@/mods/conversation-rotation";

const sendMessageStream = async () => (async function* () {})();

let dispose: (() => void) | null = null;

afterEach(() => {
  dispose?.();
  dispose = null;
});

describe("conversation rotation registry", () => {
  test("new() throws a scoped error when no session handler is registered", async () => {
    expect(hasConversationRotationHandler()).toBe(false);

    const handle = createModConversationHandle({
      agentId: "agent-1",
      conversationId: "conv-1",
      sendMessageStream,
    });

    await expect(handle.new()).rejects.toThrow(
      "Mod conversation new(): no live session in this context",
    );
  });

  test("new() delegates to the session handler and returns a handle to the new conversation", async () => {
    const requests: unknown[] = [];
    const handler: ConversationRotationHandler = async (request) => {
      requests.push(request);
      return { conversationId: "conv-new", queued: true };
    };
    dispose = registerConversationRotationHandler(handler);

    const handle = createModConversationHandle({
      agentId: "agent-1",
      conversationId: "conv-1",
      sendMessageStream,
    });

    const rotated = await handle.new({ name: "post-merge" });

    expect(requests).toEqual([{ agentId: "agent-1", name: "post-merge" }]);
    expect(rotated.id).toBe("conv-new");
    // The returned handle behaves like any other conversation handle.
    expect(typeof rotated.getHistory).toBe("function");
    expect(typeof rotated.new).toBe("function");
  });

  test("the disposer unregisters only its own handler", async () => {
    const first = registerConversationRotationHandler(async () => ({
      conversationId: "conv-a",
      queued: false,
    }));
    dispose = registerConversationRotationHandler(async () => ({
      conversationId: "conv-b",
      queued: false,
    }));

    first();
    expect(hasConversationRotationHandler()).toBe(true);
    const result = await requestConversationRotation({});
    expect(result.conversationId).toBe("conv-b");

    dispose();
    dispose = null;
    expect(hasConversationRotationHandler()).toBe(false);
  });
});
