import { expect, test } from "bun:test";
import type { SubagentStateUpdateMessage } from "@/types/app-server-protocol";
import { ChannelGateway } from "./gateway-core";
import { createChannelSubagentNoticeDelivery } from "./gateway-subagent-delivery";
import type { ChannelSubagentNoticeRoute } from "./gateway-subagent-notices";
import {
  FakeClient,
  makeDelivery,
  makeHooks,
  makeStreamDelta,
  TEST_RUNTIME,
} from "./gateway-test-support";
import type { ChannelAdapter, ChannelTurnSource } from "./types";

test("snapshot to direct reply rechecks outbound route and exact adapter at send time", async () => {
  const source: ChannelSubagentNoticeRoute = {
    channel: "signal",
    accountId: "synthetic-account",
    chatId: "synthetic-chat",
    threadId: "synthetic-thread",
    agentId: TEST_RUNTIME.agent_id,
    conversationId: TEST_RUNTIME.conversation_id,
  };
  const sent: unknown[] = [];
  let running = true;
  const adapter: ChannelAdapter = {
    id: "signal:synthetic-account",
    channelId: "signal",
    accountId: "synthetic-account",
    name: "Synthetic",
    start: async () => {},
    stop: async () => {},
    isRunning: () => running,
    sendMessage: async (message) => {
      sent.push(message);
      return { messageId: "synthetic-reply" };
    },
    sendDirectReply: async () => {
      throw new Error("Use formatted sendMessage");
    },
  };
  let authorized: ChannelTurnSource[] = [source];
  const client = new FakeClient();
  const gateway = new ChannelGateway(
    client,
    makeHooks().hooks,
    createChannelSubagentNoticeDelivery(
      {
        resolveTurnSourcesForScope: (agentId, conversationId) =>
          authorized.filter(
            (route) =>
              route.agentId === agentId &&
              route.conversationId === conversationId,
          ),
        getAdapter: (channel, account) =>
          channel === source.channel && account === source.accountId
            ? adapter
            : null,
      },
      [source],
    ),
  );
  await gateway.submit(makeDelivery({ sources: [source] }));
  function emit(id: string) {
    client.emit(
      makeStreamDelta({
        message_type: "tool_call_message",
        tool_calls: [{ tool_call_id: id, name: "Agent" }],
      }),
    );
    for (const status of ["pending", "running"] as const) {
      const message: SubagentStateUpdateMessage = {
        type: "update_subagent_state",
        runtime: TEST_RUNTIME,
        event_seq: 1,
        emitted_at: new Date().toISOString(),
        idempotency_key: id,
        subagents: [
          {
            subagent_id: id,
            subagent_type: "task",
            description: "Inspect routing",
            status,
            agent_url: null,
            tool_call_id: id,
            parent_agent_id: source.agentId,
            parent_conversation_id: source.conversationId,
            start_time: Date.now(),
            spawned_at: status === "running" ? Date.now() : undefined,
            tool_calls: [],
            total_tokens: 0,
            duration_ms: 0,
          },
        ],
      };
      client.emit(message);
    }
  }
  emit("delivered");
  await Bun.sleep(80);
  expect(sent).toEqual([
    {
      chatId: source.chatId,
      channel: "signal",
      accountId: source.accountId,
      text: "Dispatched subagent\nInspect routing",
      textStyle: ["0:19:BOLD"],
      threadId: source.threadId,
    },
  ]);
  emit("revoked-before-send");
  authorized = []; // Authorization changes after observation, before async transport.
  await Bun.sleep(80);
  expect(sent).toHaveLength(1);
  authorized = [{ ...source, accountId: "other-account" }];
  emit("wrong-account");
  await Bun.sleep(80);
  expect(sent).toHaveLength(1);
  authorized = [source];
  running = false;
  emit("stopped-adapter");
  await Bun.sleep(80);
  expect(sent).toHaveLength(1);
  gateway.close();
});
