import { expect, test } from "bun:test";
import {
  ChannelIngressBuffer,
  ChannelReloadCoordinator,
} from "@/channels/channel-reload";
import type { ChannelRegistry } from "@/channels/registry";
import {
  CHANNEL_RELOAD_ACK_TEXT,
  CHANNEL_RELOAD_RUNNING_TEXT,
  createChannelReloadHandler,
  waitForChannelTurnDrains,
} from "./channel-reload";
import { beginChannelReloadBarrier } from "./channel-reload-barrier";
import {
  activateChannelTurn,
  clearActiveChannelTurn,
} from "./channel-turn-session";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { createRuntime, enqueueChannelTurn } from "./lifecycle";
import {
  getChannelReloadBarrierBeforeDequeuing,
  scheduleQueuePump,
} from "./queue";
import { setActiveRuntime } from "./runtime";
import { LocalListenerTransport } from "./transport";
import type { StartListenerOptions } from "./types";

function createCoordinator(): ChannelReloadCoordinator {
  const ingress = new ChannelIngressBuffer<unknown>({
    isReady: () => true,
    deliver: () => {},
  });
  return new ChannelReloadCoordinator({
    adapters: new Map(),
    getAdapterKey: (channelId, accountId = "legacy") =>
      `${channelId}:${accountId}`,
    beginBuffering: () => ingress.begin(),
    startChannelAccount: async () => true,
    registerAdapter: () => {},
    log: () => {},
    createError: (failures) => new Error(JSON.stringify(failures)),
  });
}

test("reload coordination is isolated between listener hosts", async () => {
  const first = createCoordinator();
  const second = createCoordinator();
  let releaseFirst: () => void = () => {};
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let firstCompleted = false;
  const firstReload = first
    .reload({ beforeRestart: () => firstGate })
    .then(() => {
      firstCompleted = true;
    });

  await second.reload();
  expect(firstCompleted).toBe(false);

  releaseFirst();
  await firstReload;
  expect(firstCompleted).toBe(true);
});

test("drain wait ignores unrelated runs but waits for active channel turns", async () => {
  const listener = createRuntime();
  const unrelated = getOrCreateScopedRuntime(
    listener,
    "agent-unrelated",
    "conv-unrelated",
  );
  unrelated.messageQueue = new Promise<void>(() => {});
  await expect(waitForChannelTurnDrains(listener, 10)).resolves.toBeUndefined();

  const channelRuntime = getOrCreateScopedRuntime(
    listener,
    "agent-channel",
    "conv-channel",
  );
  activateChannelTurn(channelRuntime, {
    sources: [
      {
        channel: "slack",
        chatId: "C123",
        agentId: "agent-channel",
        conversationId: "conv-channel",
      },
    ],
    batchId: "batch-channel",
    progress: null,
    contextRecovered: false,
  });

  await expect(waitForChannelTurnDrains(listener, 10)).rejects.toThrow(
    "Timed out waiting for active channel turns",
  );
  clearActiveChannelTurn(channelRuntime);
  await expect(waitForChannelTurnDrains(listener, 10)).resolves.toBeUndefined();
});

test("active drain includes final delivery work inside the queued turn", async () => {
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(
    listener,
    "agent-final-delivery",
    "conv-final-delivery",
  );
  enqueueChannelTurn(
    runtime,
    {
      agentId: "agent-final-delivery",
      conversationId: "conv-final-delivery",
    },
    "channel turn with final delivery",
    [
      {
        channel: "slack",
        chatId: "C123",
        agentId: "agent-final-delivery",
        conversationId: "conv-final-delivery",
      },
    ],
  );
  let markTurnStarted: () => void = () => {};
  const turnStarted = new Promise<void>((resolve) => {
    markTurnStarted = resolve;
  });
  let releaseFinalDelivery: () => void = () => {};
  const finalDelivery = new Promise<void>((resolve) => {
    releaseFinalDelivery = resolve;
  });
  const options: StartListenerOptions = {
    connectionId: "connection-final-delivery",
    wsUrl: "ws://localhost",
    deviceId: "device-final-delivery",
    connectionName: "Final Delivery Test",
    onConnected: () => {},
    onDisconnected: () => {},
    onError: () => {},
  };

  setActiveRuntime(listener);
  try {
    scheduleQueuePump(
      runtime,
      new LocalListenerTransport(),
      options,
      async () => {
        markTurnStarted();
        await finalDelivery;
      },
    );
    await turnStarted;
    let drained = false;
    const drain = waitForChannelTurnDrains(listener, 100).then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    releaseFinalDelivery();
    await runtime.messageQueue;
    await drain;
    expect(drained).toBe(true);
  } finally {
    setActiveRuntime(null);
  }
});

test("queued channel deliveries wait behind the barrier without blocking drain", async () => {
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(
    listener,
    "agent-queued",
    "conv-queued",
  );
  enqueueChannelTurn(
    runtime,
    { agentId: "agent-queued", conversationId: "conv-queued" },
    "queued channel message",
    [
      {
        channel: "slack",
        chatId: "C123",
        agentId: "agent-queued",
        conversationId: "conv-queued",
      },
    ],
  );
  const releaseBarrier = beginChannelReloadBarrier(listener);
  const dequeueBarrier = getChannelReloadBarrierBeforeDequeuing(runtime);
  expect(dequeueBarrier).not.toBeNull();
  let dequeueReleased = false;
  void dequeueBarrier?.then(() => {
    dequeueReleased = true;
  });
  await Promise.resolve();
  expect(dequeueReleased).toBe(false);
  await expect(waitForChannelTurnDrains(listener, 10)).resolves.toBeUndefined();

  releaseBarrier();
  await dequeueBarrier;
  expect(dequeueReleased).toBe(true);
});

test("reload barrier does not block an unrelated queued turn", () => {
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(
    listener,
    "agent-unrelated-queue",
    "conv-unrelated-queue",
  );
  enqueueChannelTurn(
    runtime,
    {
      agentId: "agent-unrelated-queue",
      conversationId: "conv-unrelated-queue",
    },
    "ordinary queued message",
    [],
  );
  const releaseBarrier = beginChannelReloadBarrier(listener);

  expect(getChannelReloadBarrierBeforeDequeuing(runtime)).toBeNull();
  releaseBarrier();
});

test("channel reload reports queued, running, and completed states", async () => {
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(
    listener,
    "agent-status",
    "conv-status",
  );
  const replies: string[] = [];
  const registry = {
    getAdapter: () => ({
      isRunning: () => true,
      sendDirectReply: async (_chatId: string, text: string) => {
        replies.push(text);
      },
    }),
    reloadConfiguredChannels: async (options: {
      beforeRestart?: () => void | Promise<void>;
    }) => {
      await options.beforeRestart?.();
      return {
        restarted: ["slack/acct-status"],
        stopped: [],
        failures: [],
        bufferedDeliveries: 2,
      };
    },
  } as unknown as ChannelRegistry;
  const handler = createChannelReloadHandler({
    registry,
    listener,
    getOrCreateRuntime: () => runtime,
    reloadRuntimeSurfaces: async () => "Reloaded runtime surfaces",
    afterRuntimeReload: () => {},
  });

  const result = await handler({
    channelId: "slack",
    accountId: "acct-status",
    chatId: "C123",
    messageId: "message-status",
    threadId: "thread-status",
    route: {
      accountId: "acct-status",
      chatId: "C123",
      chatType: "channel",
      threadId: "thread-status",
      agentId: "agent-status",
      conversationId: "conv-status",
      enabled: true,
      createdAt: "2026-07-21T00:00:00.000Z",
    },
    runtime: {
      agent_id: "agent-status",
      conversation_id: "conv-status",
    },
  });

  expect(result.text).toBe(CHANNEL_RELOAD_ACK_TEXT);
  await result.afterReply?.();
  expect(replies[0]).toBe(CHANNEL_RELOAD_RUNNING_TEXT);
  expect(replies[1]).toContain(
    "Reloaded channel accounts, routes, and adapters",
  );
  expect(replies[1]).toContain("Buffered inbound messages: 2");
});

test("channel reload reports failure after its running state", async () => {
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(
    listener,
    "agent-failure",
    "conv-failure",
  );
  const replies: string[] = [];
  const registry = {
    getAdapter: () => ({
      isRunning: () => true,
      sendDirectReply: async (_chatId: string, text: string) => {
        replies.push(text);
      },
    }),
    reloadConfiguredChannels: async (options: {
      beforeRestart?: () => void | Promise<void>;
    }) => {
      await options.beforeRestart?.();
      throw new Error("adapter start failed");
    },
  } as unknown as ChannelRegistry;
  const handler = createChannelReloadHandler({
    registry,
    listener,
    getOrCreateRuntime: () => runtime,
    reloadRuntimeSurfaces: async () => "Reloaded runtime surfaces",
    afterRuntimeReload: () => {},
  });
  const result = await handler({
    channelId: "slack",
    accountId: "acct-failure",
    chatId: "C123",
    route: {
      accountId: "acct-failure",
      chatId: "C123",
      chatType: "channel",
      agentId: "agent-failure",
      conversationId: "conv-failure",
      enabled: true,
      createdAt: "2026-07-21T00:00:00.000Z",
    },
    runtime: {
      agent_id: "agent-failure",
      conversation_id: "conv-failure",
    },
  });

  await result.afterReply?.();
  expect(replies).toEqual([
    CHANNEL_RELOAD_RUNNING_TEXT,
    "Failed to reload listener settings and channels: adapter start failed",
  ]);
});
