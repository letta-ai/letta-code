import { expect, test } from "bun:test";
import type {
  SubagentSnapshot,
  SubagentStateUpdateMessage,
} from "@/types/app-server-protocol";
import { ChannelGateway } from "./gateway-core";
import {
  type ChannelSubagentNoticeRoute,
  sanitizeSubagentDescription,
} from "./gateway-subagent-notices";
import {
  FakeClient,
  makeDelivery,
  makeHooks,
  makeSource,
  makeStreamDelta,
  makeTurnFinished,
  TEST_RUNTIME,
} from "./gateway-test-support";

const route: ChannelSubagentNoticeRoute = {
  channel: "signal",
  accountId: "synthetic-account",
  chatId: "synthetic-chat",
  threadId: null,
  agentId: TEST_RUNTIME.agent_id,
  conversationId: TEST_RUNTIME.conversation_id,
};
function snapshot(
  status: SubagentSnapshot["status"],
  overrides: Partial<SubagentSnapshot> = {},
): SubagentStateUpdateMessage {
  return {
    type: "update_subagent_state",
    runtime: TEST_RUNTIME,
    event_seq: 1,
    emitted_at: new Date().toISOString(),
    idempotency_key: "synthetic-event",
    subagents: [
      {
        subagent_id: "synthetic-child",
        subagent_type: "general-purpose",
        status,
        description: "Inspect routing\nhttps://private.invalid @everyone",
        prompt: "PRIVATE PROMPT",
        model: "PRIVATE MODEL",
        agent_url: "PRIVATE URL",
        tool_call_id: "synthetic-tool",
        parent_agent_id: route.agentId,
        parent_conversation_id: route.conversationId,
        start_time: Date.now(),
        spawned_at: status === "running" ? Date.now() : undefined,
        tool_calls: [{ id: "child-tool", name: "Bash", args: "PRIVATE ARGS" }],
        total_tokens: 0,
        duration_ms: 0,
        error: "PRIVATE ERROR",
        ...overrides,
      },
    ],
  };
}
async function setup(
  routes: readonly ChannelSubagentNoticeRoute[] | undefined = [route],
  sources = [makeSource(route)],
) {
  const client = new FakeClient();
  const collected = makeHooks();
  const sent: Array<{ source: ChannelSubagentNoticeRoute; text: string }> = [];
  const gateway = new ChannelGateway(
    client,
    collected.hooks,
    routes
      ? {
          routes,
          send: async (source, text) => {
            sent.push({ source, text });
          },
        }
      : undefined,
  );
  await gateway.submit(makeDelivery({ sources }));
  client.emit(
    makeStreamDelta({
      message_type: "tool_call_message",
      tool_calls: [{ tool_call_id: "synthetic-tool", name: "Agent" }],
    }),
  );
  await Bun.sleep(80);
  collected.progressEvents.length = 0;
  return { client, gateway, sent, ...collected };
}

test("real gateway event path announces confirmed spawn once and never child content or completion", async () => {
  const h = await setup();
  const pending = snapshot("pending");
  const running = snapshot("running");
  h.client.emit(pending);
  expect(h.sent).toHaveLength(0);
  h.client.emit(running);
  h.client.emit(running);
  h.client.emit(pending); // Full replay, not just duplicate event keys.
  h.client.emit(running);
  h.client.emit({
    ...makeStreamDelta({
      message_type: "assistant_message",
      content: "PRIVATE RESULT",
    }),
    subagent_id: "synthetic-child",
  });
  h.client.emit({
    ...makeStreamDelta({
      message_type: "stop_reason",
      stop_reason: "end_turn",
    }),
    subagent_id: "synthetic-child",
  });
  h.client.emit(snapshot("completed"));
  await Bun.sleep(80);
  expect(h.sent).toEqual([
    {
      source: route,
      text: "**Dispatched subagent**\nInspect routing link removed",
    },
  ]);
  expect(h.progressEvents).toHaveLength(0);
  expect(
    h.lifecycleEvents.filter((event) => event.type === "finished"),
  ).toHaveLength(0);
  h.client.emit(makeTurnFinished("end_turn"));
  await Bun.sleep(80);
  expect(
    h.lifecycleEvents.filter((event) => event.type === "finished"),
  ).toHaveLength(1);
  await h.gateway.submit(
    makeDelivery({
      clientMessageId: "next-turn",
      sources: [makeSource(route)],
    }),
  );
  h.client.emit(pending);
  h.client.emit(running);
  await Bun.sleep(80);
  expect(h.sent).toHaveLength(1);
  h.gateway.close();
});

test("batches separate confirmed spawn frames, preserving one description per child", async () => {
  const h = await setup();
  for (const [subagent_id, description] of [
    ["one", "Inspect routing"],
    ["two", "Write tests"],
  ]) {
    h.client.emit(
      makeStreamDelta({
        message_type: "tool_call_message",
        tool_calls: [{ tool_call_id: subagent_id, name: "Agent" }],
      }),
    );
    h.client.emit(
      snapshot("pending", {
        subagent_id,
        description,
        tool_call_id: subagent_id,
      }),
    );
    h.client.emit(
      snapshot("running", {
        subagent_id,
        tool_call_id: subagent_id,
        description: "Do not replace the original label",
      }),
    );
  }
  // A pending sibling must not be announced just because others spawned.
  h.client.emit(snapshot("pending", { subagent_id: "not-spawned" }));
  await Bun.sleep(80);
  expect(h.sent).toEqual([
    {
      source: route,
      text: "**Dispatched subagents**\nInspect routing\nWrite tests",
    },
  ]);
  h.gateway.close();
});

test("revoking opt-in during the batch window suppresses delivery", async () => {
  const routes = [route];
  const h = await setup(routes);
  h.client.emit(snapshot("pending"));
  h.client.emit(snapshot("running"));
  routes.length = 0;
  await Bun.sleep(80);
  expect(h.sent).toHaveLength(0);
  h.gateway.close();
});

test("description sanitizer flattens controls and strips references and formatting", () => {
  const text = sanitizeSubagentDescription(
    "**Inspect**\n\u001b[31mrouting\u001b[0m @everyone <@123> https://private.invalid /home/private file@example.com sk-secret123 \u202esection",
  );
  expect(text).toBe(
    "Inspect routing link removed path removed email removed secret removed section",
  );
  expect(sanitizeSubagentDescription("\n @everyone **")).toBe("Delegated task");
  expect(sanitizeSubagentDescription("x".repeat(200))).toHaveLength(160);
  expect(sanitizeSubagentDescription(null)).toBe("Delegated task");
});

test("actual task labels redact credential assignments through the gateway event path", async () => {
  const h = await setup();
  const description =
    'Inspect PASSWORD="synthetic-pass" api_key=synthetic-key Authorization: Bearer synthetic.bearer.secret';
  h.client.emit(snapshot("pending", { description }));
  h.client.emit(snapshot("running"));
  await Bun.sleep(80);
  expect(h.sent).toHaveLength(1);
  expect(h.sent[0]?.text).toContain("Inspect");
  for (const secret of [
    "synthetic-pass",
    "synthetic-key",
    "synthetic.bearer.secret",
  ]) {
    expect(h.sent[0]?.text).not.toContain(secret);
  }
  h.gateway.close();
});

test("separate opted-in runtime batches never combine task descriptions", async () => {
  const other = {
    ...route,
    accountId: "other-account",
    chatId: "other-chat",
    conversationId: "other-conversation",
  };
  const otherRuntime = {
    ...TEST_RUNTIME,
    conversation_id: other.conversationId,
  };
  const h = await setup([route, other]);
  await h.gateway.submit(
    makeDelivery({
      runtime: otherRuntime,
      sources: [other],
      clientMessageId: "other-input",
    }),
  );
  h.client.emit(
    makeStreamDelta(
      {
        message_type: "tool_call_message",
        tool_calls: [{ tool_call_id: "other-tool", name: "Agent" }],
      },
      otherRuntime,
    ),
  );
  for (const status of ["pending", "running"] as const) {
    h.client.emit(snapshot(status, { description: "First route task" }));
    h.client.emit({
      ...snapshot(status, {
        description: "Second route task",
        parent_conversation_id: other.conversationId,
        tool_call_id: "other-tool",
      }),
      runtime: otherRuntime,
    });
  }
  await Bun.sleep(80);
  expect(h.sent).toEqual([
    { source: route, text: "**Dispatched subagent**\nFirst route task" },
    { source: other, text: "**Dispatched subagent**\nSecond route task" },
  ]);
  h.gateway.close();
});

test("default is off, including an explicit empty route list", async () => {
  for (const routes of [undefined, []]) {
    // Avoid the setup helper's default argument when testing absent options.
    const client = new FakeClient();
    let sends = 0;
    const gateway = new ChannelGateway(
      client,
      makeHooks().hooks,
      routes
        ? {
            routes,
            send: async () => {
              sends++;
            },
          }
        : undefined,
    );
    await gateway.submit(makeDelivery({ sources: [makeSource(route)] }));
    client.emit(snapshot("pending"));
    client.emit(snapshot("running"));
    await Bun.sleep(80);
    expect(sends).toBe(0);
    gateway.close();
  }
});

test("exact route opt-in cannot bleed across accounts, chats, threads, agents or conversations", async () => {
  for (const change of [
    { channel: "telegram" },
    { accountId: "other-account" },
    { chatId: "other-chat" },
    { threadId: "other-thread" },
    { agentId: "other-agent" },
    { conversationId: "other-conversation" },
  ]) {
    const h = await setup([{ ...route, ...change }]);
    h.client.emit(snapshot("pending"));
    h.client.emit(snapshot("running"));
    await Bun.sleep(80);
    expect(h.sent).toHaveLength(0);
    h.gateway.close();
  }
});

test("foreign envelope, foreign child scope, silent children and missing tool attribution are ignored", async () => {
  for (const change of [
    { parent_agent_id: "other-agent" },
    { parent_conversation_id: "other-conversation" },
    { parent_agent_id: undefined },
    { tool_call_id: undefined },
    { silent: true },
  ]) {
    const h = await setup();
    h.client.emit(snapshot("pending", change));
    h.client.emit(snapshot("running", change));
    await Bun.sleep(80);
    expect(h.sent).toHaveLength(0);
    h.gateway.close();
  }
  const h = await setup();
  for (const status of ["pending", "running"] as const)
    h.client.emit({
      ...snapshot(status),
      runtime: { ...TEST_RUNTIME, agent_id: "other-agent" },
    });
  await Bun.sleep(80);
  expect(h.sent).toHaveLength(0);
  h.gateway.close();
});

test("spawn failure, no event, recovery-only running, stale pending and terminal-only states send nothing", async () => {
  const h = await setup();
  h.client.emit(snapshot("running", { subagent_id: "recovery" }));
  h.client.emit(snapshot("pending", { subagent_id: "failed" }));
  h.client.emit(snapshot("error", { subagent_id: "failed" }));
  h.client.emit(snapshot("running", { subagent_id: "failed" }));
  h.client.emit(snapshot("completed", { subagent_id: "terminal-only" }));
  h.client.emit(snapshot("pending", { subagent_id: "stale", start_time: 1 }));
  h.client.emit(snapshot("running", { subagent_id: "stale", start_time: 1 }));
  await Bun.sleep(80);
  expect(h.sent).toHaveLength(0);
  h.gateway.close();
});

test("ambiguous, inactive, ended, and closed parent turns do not announce", async () => {
  const h = await setup(
    [route],
    [makeSource(route), makeSource({ ...route, chatId: "second-chat" })],
  );
  h.client.emit(snapshot("pending"));
  h.client.emit(snapshot("running"));
  await Bun.sleep(80);
  expect(h.sent).toHaveLength(0);
  h.gateway.close();
  const ended = await setup();
  ended.client.emit(snapshot("pending"));
  ended.client.emit(makeTurnFinished("end_turn"));
  ended.client.emit(snapshot("running"));
  await Bun.sleep(80);
  expect(ended.sent).toHaveLength(0);
  ended.gateway.close();
  const closed = await setup();
  closed.client.emit(snapshot("pending"));
  closed.client.emit(snapshot("running"));
  closed.gateway.close();
  await Bun.sleep(80);
  expect(closed.sent).toHaveLength(0);
});

test("requires parent tool correlation and tolerates control/data lane reordering", async () => {
  const h = await setup();
  h.client.emit(snapshot("pending", { tool_call_id: "late-tool" }));
  h.client.emit(snapshot("running", { tool_call_id: "late-tool" }));
  await Bun.sleep(80);
  expect(h.sent).toHaveLength(0);
  // An unrelated parent's tool or a child tool must never supply attribution.
  h.client.emit({
    ...makeStreamDelta({
      message_type: "tool_call_message",
      tool_calls: [{ tool_call_id: "late-tool", name: "Agent" }],
    }),
    subagent_id: "other-child",
  });
  await Bun.sleep(80);
  expect(h.sent).toHaveLength(0);
  h.client.emit(
    makeStreamDelta({
      message_type: "tool_call_message",
      tool_calls: [{ tool_call_id: "late-tool", name: "Agent" }],
    }),
  );
  await Bun.sleep(80);
  expect(h.sent).toHaveLength(1);
  h.gateway.close();
});

test("handoff cannot announce replayed pending/running snapshots", async () => {
  const client = new FakeClient();
  let sent = 0;
  const gateway = new ChannelGateway(client, makeHooks().hooks, {
    routes: [route],
    send: async () => {
      sent++;
    },
  });
  await gateway.adoptActiveDelivery(
    makeDelivery({ sources: [makeSource(route)] }),
  );
  client.emit(
    makeStreamDelta({
      message_type: "tool_call_message",
      tool_calls: [{ tool_call_id: "synthetic-tool", name: "Agent" }],
    }),
  );
  client.emit(snapshot("pending"));
  client.emit(snapshot("running"));
  await Bun.sleep(80);
  expect(sent).toBe(0);
  gateway.close();
});

test("transport failure is not retried on replay and does not finish parent", async () => {
  const client = new FakeClient();
  const collected = makeHooks();
  let attempts = 0;
  const gateway = new ChannelGateway(client, collected.hooks, {
    routes: [route],
    send: async () => {
      attempts++;
      throw new Error("PRIVATE TRANSPORT ERROR");
    },
  });
  await gateway.submit(makeDelivery({ sources: [makeSource(route)] }));
  client.emit(
    makeStreamDelta({
      message_type: "tool_call_message",
      tool_calls: [{ tool_call_id: "synthetic-tool", name: "Agent" }],
    }),
  );
  client.emit(snapshot("pending"));
  client.emit(snapshot("running"));
  await Bun.sleep(80);
  client.emit(snapshot("pending"));
  client.emit(snapshot("running"));
  await Bun.sleep(80);
  expect(attempts).toBe(1);
  expect(
    collected.lifecycleEvents.filter((event) => event.type === "finished"),
  ).toHaveLength(0);
  gateway.close();
});
