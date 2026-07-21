import { describe, expect, test } from "bun:test";
import { ChannelRegistry, getChannelRegistry } from "@/channels/registry";
import type {
  ChannelAdapter,
  ChannelTurnLifecycleEvent,
} from "@/channels/types";

import {
  activateChannelTurn,
  type ChannelTurnRuntimeCarrier,
  clearActiveChannelTurn,
  finishActiveChannelTurn,
  getActiveChannelTurnDrainPromise,
  getActiveChannelTurnProgressContext,
  recoverActiveChannelTurn,
  resolveTurnLifecycleTerminal,
} from "./channel-turn-session";

test("channel turn session activates and clears all runtime state atomically", () => {
  const runtime: ChannelTurnRuntimeCarrier = { activeChannelTurn: null };
  const source = {
    channel: "slack",
    accountId: "acct-1",
    chatId: "C123",
    chatType: "channel" as const,
    threadId: "1712790000.000050",
    agentId: "agent-1",
    conversationId: "conv-1",
  };
  const progress = { buildUpdates: () => [] };

  const activeTurn = activateChannelTurn(runtime, {
    sources: [source],
    batchId: "batch-1",
    progress,
    contextRecovered: true,
  });

  expect(runtime.activeChannelTurn).toBe(activeTurn);
  expect(getActiveChannelTurnProgressContext(runtime)).toEqual({
    sources: [source],
    batchId: "batch-1",
    progressBuilder: progress,
  });

  clearActiveChannelTurn(runtime);
  expect(runtime.activeChannelTurn).toBeNull();
  expect(getActiveChannelTurnProgressContext(runtime)).toBeNull();
});

test("channel drain remains pending through final lifecycle delivery", async () => {
  await getChannelRegistry()?.stopAll();
  const registry = new ChannelRegistry();
  let releaseFinalDelivery: () => void = () => {};
  const finalDelivery = new Promise<void>((resolve) => {
    releaseFinalDelivery = resolve;
  });
  registry.registerAdapter({
    id: "slack:acct-1",
    channelId: "slack",
    accountId: "acct-1",
    name: "Slack",
    start: async () => {},
    stop: async () => {},
    isRunning: () => true,
    sendMessage: async () => ({ messageId: "message-1" }),
    sendDirectReply: async () => {},
    handleTurnLifecycleEvent: async (event) => {
      if (event.type === "finished") await finalDelivery;
    },
  });
  const runtime: ChannelTurnRuntimeCarrier = { activeChannelTurn: null };
  activateChannelTurn(runtime, {
    sources: [
      {
        channel: "slack",
        accountId: "acct-1",
        chatId: "C123",
        agentId: "agent-1",
        conversationId: "conv-1",
      },
    ],
    batchId: "batch-drain",
    progress: null,
    contextRecovered: false,
  });
  const drain = getActiveChannelTurnDrainPromise(runtime);
  let drained = false;
  void drain?.then(() => {
    drained = true;
  });

  const finishing = finishActiveChannelTurn(runtime, {
    lastStopReason: "end_turn",
    didThrow: false,
  });
  await Promise.resolve();
  expect(drained).toBe(false);

  releaseFinalDelivery();
  await finishing;
  await drain;
  expect(drained).toBe(true);
  await registry.stopAll();
});

test("approval continuation keeps the channel drain active", async () => {
  const runtime: ChannelTurnRuntimeCarrier = { activeChannelTurn: null };
  activateChannelTurn(runtime, {
    sources: [
      {
        channel: "slack",
        chatId: "C123",
        agentId: "agent-1",
        conversationId: "conv-1",
      },
    ],
    batchId: "batch-approval",
    progress: null,
    contextRecovered: false,
  });
  const drain = getActiveChannelTurnDrainPromise(runtime);

  await finishActiveChannelTurn(runtime, {
    lastStopReason: "requires_approval",
    didThrow: false,
    retainOnApproval: true,
  });

  expect(runtime.activeChannelTurn).toBeNull();
  expect(getActiveChannelTurnDrainPromise(runtime)).toBe(drain);
  recoverActiveChannelTurn(runtime, {
    sources: [
      {
        channel: "slack",
        chatId: "C123",
        agentId: "agent-1",
        conversationId: "conv-1",
      },
    ],
    batchId: "batch-approval",
    progress: null,
  });
  expect(getActiveChannelTurnDrainPromise(runtime)).toBe(drain);
  await finishActiveChannelTurn(runtime, {
    lastStopReason: "end_turn",
    didThrow: false,
  });
  await drain;
});

test("clearing a pending approval releases its preserved channel drain", async () => {
  const runtime: ChannelTurnRuntimeCarrier = { activeChannelTurn: null };
  activateChannelTurn(runtime, {
    sources: [
      {
        channel: "slack",
        chatId: "C123",
        agentId: "agent-1",
        conversationId: "conv-1",
      },
    ],
    batchId: "batch-cancelled-approval",
    progress: null,
    contextRecovered: false,
  });
  const drain = getActiveChannelTurnDrainPromise(runtime);
  await finishActiveChannelTurn(runtime, {
    lastStopReason: "requires_approval",
    didThrow: false,
    retainOnApproval: true,
  });

  clearActiveChannelTurn(runtime);
  await drain;
  expect(getActiveChannelTurnDrainPromise(runtime)).toBeNull();
});

test("recovered channel turns are marked explicitly", () => {
  const runtime: ChannelTurnRuntimeCarrier = { activeChannelTurn: null };
  const recovered = recoverActiveChannelTurn(runtime, {
    sources: [],
    batchId: "recovered-batch",
    progress: null,
  });

  expect(recovered.contextRecovered).toBe(true);
  expect(runtime.activeChannelTurn).toBe(recovered);
});

test("finishing a channel turn dispatches its terminal exactly once", async () => {
  await getChannelRegistry()?.stopAll();
  const registry = new ChannelRegistry();
  const events: ChannelTurnLifecycleEvent[] = [];
  const adapter: ChannelAdapter = {
    id: "slack:acct-1",
    channelId: "slack",
    accountId: "acct-1",
    name: "Slack",
    start: async () => {},
    stop: async () => {},
    isRunning: () => true,
    sendMessage: async () => ({ messageId: "message-1" }),
    sendDirectReply: async () => {},
    handleTurnLifecycleEvent: async (event) => {
      events.push(event);
    },
  };
  registry.registerAdapter(adapter);
  const runtime: ChannelTurnRuntimeCarrier = { activeChannelTurn: null };
  activateChannelTurn(runtime, {
    sources: [
      {
        channel: "slack",
        accountId: "acct-1",
        chatId: "C123",
        chatType: "channel",
        threadId: "1712790000.000050",
        agentId: "agent-1",
        conversationId: "conv-1",
      },
    ],
    batchId: "batch-1",
    progress: null,
    contextRecovered: false,
  });

  try {
    const first = await finishActiveChannelTurn(runtime, {
      lastStopReason: "end_turn",
      didThrow: false,
    });
    const second = await finishActiveChannelTurn(runtime, {
      lastStopReason: "end_turn",
      didThrow: false,
    });

    expect(first.dispatched).toBe(true);
    expect(second.dispatched).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "finished",
      batchId: "batch-1",
      outcome: "completed",
      stopReason: "end_turn",
    });
  } finally {
    await registry.stopAll();
  }
});

describe("channel turn terminal mapping", () => {
  test.each([
    ["end_turn", "completed"],
    ["tool_rule", "completed"],
    ["cancelled", "cancelled"],
    ["error", "error"],
    ["llm_api_error", "error"],
    ["invalid_llm_response", "error"],
    ["invalid_tool_call", "error"],
    ["max_steps", "error"],
    ["max_tokens_exceeded", "error"],
    ["no_tool_call", "error"],
    ["insufficient_credits", "error"],
    ["context_window_overflow_in_system_prompt", "error"],
  ] as const)(
    "preserves %s instead of collapsing it",
    (stopReason, outcome) => {
      expect(resolveTurnLifecycleTerminal(stopReason, false)).toEqual({
        outcome,
        stopReason,
      });
    },
  );

  test("a thrown turn cannot report a stale successful stop reason", () => {
    expect(resolveTurnLifecycleTerminal("end_turn", true)).toEqual({
      outcome: "error",
      stopReason: "error",
    });
  });

  test("requires_approval remains distinguishable as a continuation boundary", () => {
    expect(resolveTurnLifecycleTerminal("requires_approval", false)).toEqual({
      outcome: "error",
      stopReason: "requires_approval",
    });
  });
});
