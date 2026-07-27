import { describe, expect, test } from "bun:test";
import WebSocket from "ws";
import { AppServerConnectionRouter } from "@/websocket/app-server-connections";
import { getOrCreateScopedRuntime } from "@/websocket/listener/conversation-runtime";
import { createRuntime } from "@/websocket/listener/lifecycle";
import { emitProtocolV2Message } from "@/websocket/listener/protocol-outbound";
import { getConversationRuntimeKey } from "@/websocket/listener/runtime";

class MockSocket {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  readonly sent: Record<string, unknown>[] = [];

  send(payload: string): void {
    this.sent.push(JSON.parse(payload) as Record<string, unknown>);
  }

  close(): void {
    this.readyState = WebSocket.CLOSED;
  }
}

describe("app-server connection router", () => {
  test("routes scoped frames only to their owner with per-connection sequence numbers", () => {
    const runtime = createRuntime();
    const router = new AppServerConnectionRouter(runtime);
    const socketA = new MockSocket();
    const socketB = new MockSocket();
    const connectionA = router.add(socketA as unknown as WebSocket);
    const connectionB = router.add(socketB as unknown as WebSocket);
    const scopeA = { agent_id: "agent-a", conversation_id: "conversation-a" };
    const scopeB = { agent_id: "agent-b", conversation_id: "conversation-b" };

    router.claim(connectionA, scopeA);
    router.claim(connectionB, scopeB);
    const conversationRuntimeA = getOrCreateScopedRuntime(
      runtime,
      scopeA.agent_id,
      scopeA.conversation_id,
    );
    getOrCreateScopedRuntime(runtime, scopeB.agent_id, scopeB.conversation_id);
    const runtimeKeyA = getConversationRuntimeKey(
      scopeA.agent_id,
      scopeA.conversation_id,
    );
    runtime.skillSourcesByConversation.set(runtimeKeyA, []);
    runtime.reminderStateByConversation.set(
      runtimeKeyA,
      conversationRuntimeA.reminderState,
    );

    emitProtocolV2Message(
      socketA as unknown as WebSocket,
      conversationRuntimeA,
      {
        type: "stream_delta",
        delta: { message_type: "assistant_message", content: "direct A" },
      } as never,
    );
    router.send(
      JSON.stringify({
        type: "stream_delta",
        runtime: scopeA,
        event_seq: 99,
        idempotency_key: "old-a",
        delta: { content: "A" },
      }),
    );
    router.send(
      JSON.stringify({
        type: "stream_delta",
        runtime: scopeB,
        event_seq: 100,
        idempotency_key: "old-b",
        delta: { content: "B" },
      }),
    );

    expect(socketA.sent).toHaveLength(2);
    expect(socketB.sent).toHaveLength(1);
    expect(socketA.sent[0]).toMatchObject({
      runtime: scopeA,
      event_seq: 1,
    });
    expect(socketA.sent[1]).toMatchObject({
      runtime: scopeA,
      event_seq: 2,
    });
    expect(socketB.sent[0]).toMatchObject({
      runtime: scopeB,
      event_seq: 1,
    });

    router.remove(connectionA);
    expect(runtime.conversationRuntimes.has(runtimeKeyA)).toBe(false);
    expect(
      runtime.conversationRuntimes.has(
        getConversationRuntimeKey(scopeB.agent_id, scopeB.conversation_id),
      ),
    ).toBe(true);
    expect(runtime.skillSourcesByConversation.has(runtimeKeyA)).toBe(false);
    expect(runtime.reminderStateByConversation.has(runtimeKeyA)).toBe(false);

    router.send(
      JSON.stringify({
        type: "stream_delta",
        runtime: scopeB,
        event_seq: 101,
        idempotency_key: "old-b-2",
        delta: { content: "still connected" },
      }),
    );
    expect(socketA.sent).toHaveLength(2);
    expect(socketB.sent[1]).toMatchObject({
      runtime: scopeB,
      event_seq: 2,
    });
  });

  test("rejects an ambiguous second owner without replacing the first", () => {
    const router = new AppServerConnectionRouter(createRuntime());
    const connectionA = router.add(new MockSocket() as unknown as WebSocket);
    const connectionB = router.add(new MockSocket() as unknown as WebSocket);
    const scope = { agent_id: "agent-1", conversation_id: "conversation-1" };

    expect(router.claim(connectionA, scope)).toBe("claimed");
    expect(() => router.claim(connectionB, scope)).toThrow(
      /already owned by another app-server connection/,
    );
    expect(router.owns(connectionA, scope)).toBe(true);
    expect(router.owns(connectionB, scope)).toBe(false);
  });
});
