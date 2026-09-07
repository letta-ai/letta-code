import { expect, test } from "bun:test";
import {
  clearSubagentsByIds,
  registerSubagent,
  subscribe,
  updateSubagent,
} from "@/agent/subagent-state";
import { ChannelGateway } from "@/channels/gateway-core";
import type { ChannelSubagentNoticeRoute } from "@/channels/gateway-subagent-notices";
import {
  FakeClient,
  makeDelivery,
  makeHooks,
  makeStreamDelta,
  TEST_RUNTIME,
} from "@/channels/gateway-test-support";
import { emitSubagentStateUpdate } from "./protocol-outbound";
import type { ConversationRuntime, ListenerRuntime } from "./types";

test("registry-to-listener-to-gateway requires actual spawn observation, not eager fork URL", async () => {
  const client = new FakeClient();
  const route: ChannelSubagentNoticeRoute = {
    channel: "signal",
    accountId: "synthetic-account",
    chatId: "synthetic-chat",
    agentId: TEST_RUNTIME.agent_id,
    conversationId: TEST_RUNTIME.conversation_id,
  };
  const sent: string[] = [];
  const gateway = new ChannelGateway(client, makeHooks().hooks, {
    routes: [route],
    send: async (_source, text) => {
      sent.push(text);
    },
  });
  await gateway.submit(makeDelivery({ sources: [route] }));
  client.emit(
    makeStreamDelta({
      message_type: "tool_call_message",
      tool_calls: [{ tool_call_id: "synthetic-spawn-tool", name: "Agent" }],
    }),
  );
  const wire: unknown[] = [];
  const socket = {
    readyState: 1,
    bufferedAmount: 0,
    send(data: string) {
      const message = JSON.parse(data);
      wire.push(message);
      client.emit(message);
    },
  };
  const listener = {
    socket,
    transport: socket,
    streamTransport: null,
    eventSeqCounter: 0,
    connections: new Map(),
    connectionIdsByRuntimeKey: new Map(),
    conversationRuntimes: new Map(),
  } as unknown as ListenerRuntime;
  const runtime = {
    listener,
    agentId: route.agentId,
    conversationId: route.conversationId,
  } as unknown as ConversationRuntime;
  listener.conversationRuntimes.set("synthetic", runtime);
  const unsubscribe = subscribe(() =>
    emitSubagentStateUpdate(socket as never, runtime),
  );
  const id = "synthetic-spawn-snapshot-child";
  try {
    registerSubagent(
      id,
      "general-purpose",
      "Inspect routing",
      "synthetic-spawn-tool",
      true,
      false,
      { agentId: route.agentId, conversationId: route.conversationId },
      "PRIVATE PROMPT",
    );
    updateSubagent(id, { agentURL: "synthetic-fork-url" }); // Existing eager URL projection marks running.
    await Bun.sleep(80);
    expect(wire).toHaveLength(2);
    expect(wire.at(-1)).toMatchObject({
      type: "update_subagent_state",
      runtime: TEST_RUNTIME,
      subagents: [{ status: "running" }],
    });
    expect(sent).toHaveLength(0);
    updateSubagent(id, { status: "running", spawnedAt: Date.now() }); // Child process `spawn` producer.
    await Bun.sleep(80);
    expect(wire.at(-1)).toMatchObject({
      subagents: [{ spawned_at: expect.any(Number) }],
    });
    expect(sent).toEqual(["**Dispatched subagent**\nInspect routing"]);
    updateSubagent(id, { status: "completed" });
    await Bun.sleep(80);
    expect(sent).toHaveLength(1);
  } finally {
    unsubscribe();
    clearSubagentsByIds([id]);
    gateway.close();
  }
});
