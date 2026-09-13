import { describe, expect, test } from "bun:test";
import WebSocket from "ws";
import { queueSkillContent } from "@/tools/impl/skill-content-registry";
import type { StreamDeltaMessage } from "@/types/protocol_v2";
import { injectQueuedSkillContent } from "./skill-injection";
import type { ConversationRuntime, ListenerRuntime } from "./types";

class MockSocket {
  readyState = WebSocket.OPEN;
  bufferedAmount = 0;
  sentPayloads: string[] = [];

  send(data: string): void {
    this.sentPayloads.push(data);
  }
}

function createRuntime(): {
  runtime: ConversationRuntime;
  socket: MockSocket;
} {
  const socket = new MockSocket();
  const listener = {
    socket: socket as never,
    transport: socket as never,
    streamTransport: null,
    eventSeqCounter: 0,
    connections: new Map(),
    connectionIdsByRuntimeKey: new Map(),
    conversationRuntimes: new Map(),
  } as unknown as ListenerRuntime;
  const runtime = {
    listener,
    agentId: "agent-1",
    conversationId: "conv-1",
  } as unknown as ConversationRuntime;
  listener.conversationRuntimes.set("test", runtime);
  return { runtime, socket };
}

describe("injectQueuedSkillContent", () => {
  test("echoes the injected user message with the request OTID and content", () => {
    const { runtime, socket } = createRuntime();
    const content = [
      "<review-pr>\n---\nname: review-pr\ndescription: Review a pull request\n---\nInstructions\n</review-pr>",
    ].join("\n");
    queueSkillContent("tool-call-1", content);

    const messages = injectQueuedSkillContent([], {
      socket: socket as never,
      runtime,
      agentId: "agent-1",
      conversationId: "conv-1",
    });

    expect(messages).toHaveLength(1);
    const injected = messages[0];
    if (!injected) {
      throw new Error("Expected an injected skill message");
    }
    expect("otid" in injected && injected.otid).toEqual(expect.any(String));
    expect("content" in injected && injected.content).toEqual([
      { type: "text", text: content },
    ]);

    expect(socket.sentPayloads).toHaveLength(1);
    const frame = JSON.parse(
      socket.sentPayloads[0] ?? "{}",
    ) as StreamDeltaMessage;
    expect(frame.runtime).toEqual({
      agent_id: "agent-1",
      conversation_id: "conv-1",
    });
    expect(frame.delta).toMatchObject({
      id: expect.stringMatching(/^user-msg-/),
      message_type: "user_message",
      content: [{ type: "text", text: content }],
      otid: "otid" in injected ? injected.otid : undefined,
    });
    expect("seq_id" in frame.delta).toBe(false);
  });
});
