import { expect, test } from "bun:test";
import {
  createTelegramAdapter,
  FakeBot,
  installTelegramAdapterTestHooks,
  telegramAccountDefaults,
} from "./telegram/adapter-test-harness";

installTelegramAdapterTestHooks();

test("telegram adapter owns typing from queue acceptance through completion", async () => {
  const adapter = createTelegramAdapter({
    ...telegramAccountDefaults,
    channel: "telegram",
    enabled: true,
    token: "test-token",
    dmPolicy: "pairing",
    allowedUsers: [],
  });

  await adapter.start();

  const turnSource = {
    channel: "telegram",
    accountId: "telegram-test-account",
    chatId: "555",
    chatType: "direct" as const,
    messageId: "42",
    threadId: null,
    agentId: "agent-1",
    conversationId: "conv-1",
  };

  await adapter.handleTurnLifecycleEvent?.({
    type: "queued",
    source: turnSource,
  });

  const bot = FakeBot.instances[0];
  expect(bot?.api.sendChatAction).toHaveBeenCalledWith("555", "typing", {});

  await adapter.handleTurnLifecycleEvent?.({
    type: "processing",
    batchId: "batch-1",
    sources: [turnSource],
  });

  const initialCallCount = bot?.api.sendChatAction.mock.calls.length ?? 0;
  expect(initialCallCount).toBeGreaterThanOrEqual(1);

  await adapter.handleTurnLifecycleEvent?.({
    type: "processing",
    batchId: "batch-1",
    sources: [turnSource],
  });
  expect(bot?.api.sendChatAction.mock.calls.length).toBe(initialCallCount);

  await adapter.handleTurnLifecycleEvent?.({
    type: "finished",
    batchId: "batch-1",
    sources: [turnSource],
    outcome: "completed",
    stopReason: "end_turn",
  });

  await adapter.handleTurnLifecycleEvent?.({
    type: "processing",
    batchId: "batch-2",
    sources: [turnSource],
  });
  expect(bot?.api.sendChatAction.mock.calls.length).toBe(initialCallCount + 1);

  await adapter.stop();

  const totalCallsAfterStop = bot?.api.sendChatAction.mock.calls.length ?? 0;
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(bot?.api.sendChatAction.mock.calls.length).toBe(totalCallsAfterStop);
});

test("telegram adapter keeps lifecycle ownership after sending a message", async () => {
  const adapter = createTelegramAdapter({
    ...telegramAccountDefaults,
    channel: "telegram",
    enabled: true,
    token: "test-token",
    dmPolicy: "pairing",
    allowedUsers: [],
  });

  await adapter.start();

  const turnSource = {
    channel: "telegram",
    accountId: "telegram-test-account",
    chatId: "555",
    chatType: "direct" as const,
    messageId: "42",
    threadId: null,
    agentId: "agent-1",
    conversationId: "conv-1",
  };

  await adapter.handleTurnLifecycleEvent?.({
    type: "processing",
    batchId: "batch-1",
    sources: [turnSource],
  });

  const bot = FakeBot.instances[0];
  expect(bot?.api.sendChatAction).toHaveBeenCalledTimes(1);

  await adapter.sendMessage({
    channel: "telegram",
    chatId: "555",
    text: "done",
  });

  await adapter.handleTurnLifecycleEvent?.({
    type: "processing",
    batchId: "batch-1",
    sources: [turnSource],
  });

  expect(bot?.api.sendChatAction).toHaveBeenCalledTimes(1);

  await adapter.stop();
});

test("telegram adapter reference-counts sources per forum topic", async () => {
  const adapter = createTelegramAdapter({
    ...telegramAccountDefaults,
    channel: "telegram",
    enabled: true,
    token: "test-token",
    dmPolicy: "pairing",
    allowedUsers: [],
  });
  await adapter.start();
  const first = {
    channel: "telegram",
    accountId: "telegram-test-account",
    chatId: "555",
    chatType: "channel" as const,
    messageId: "42",
    threadId: "7",
    agentId: "agent-1",
    conversationId: "conv-1",
  };
  const second = { ...first, messageId: "43" };
  const otherTopic = { ...first, messageId: "44", threadId: "8" };

  await adapter.handleTurnLifecycleEvent?.({ type: "queued", source: first });
  await adapter.handleTurnLifecycleEvent?.({ type: "queued", source: second });
  await adapter.handleTurnLifecycleEvent?.({
    type: "queued",
    source: otherTopic,
  });

  const bot = FakeBot.instances[0];
  expect(bot?.api.sendChatAction).toHaveBeenCalledWith("555", "typing", {
    message_thread_id: 7,
  });
  expect(bot?.api.sendChatAction).toHaveBeenCalledWith("555", "typing", {
    message_thread_id: 8,
  });
  expect(bot?.api.sendChatAction).toHaveBeenCalledTimes(2);

  await adapter.handleTurnLifecycleEvent?.({
    type: "finished",
    batchId: "batch-1",
    sources: [first],
    outcome: "completed",
    stopReason: "end_turn",
  });
  await adapter.handleTurnLifecycleEvent?.({
    type: "processing",
    batchId: "batch-2",
    sources: [second],
  });
  expect(bot?.api.sendChatAction).toHaveBeenCalledTimes(2);

  await adapter.stop();
});

test("telegram adapter cancelled releases typing; sibling keeps topic active", async () => {
  const adapter = createTelegramAdapter({
    ...telegramAccountDefaults,
    channel: "telegram",
    enabled: true,
    token: "test-token",
    dmPolicy: "pairing",
    allowedUsers: [],
  });
  await adapter.start();

  const first = {
    channel: "telegram",
    accountId: "telegram-test-account",
    chatId: "555",
    chatType: "channel" as const,
    messageId: "42",
    threadId: "7",
    agentId: "agent-1",
    conversationId: "conv-1",
  };
  const second = { ...first, messageId: "43" };
  const otherTopic = { ...first, messageId: "44", threadId: "8" };

  await adapter.handleTurnLifecycleEvent?.({ type: "queued", source: first });
  await adapter.handleTurnLifecycleEvent?.({ type: "queued", source: second });
  await adapter.handleTurnLifecycleEvent?.({
    type: "queued",
    source: otherTopic,
  });

  const bot = FakeBot.instances[0];
  expect(bot?.api.sendChatAction).toHaveBeenCalledTimes(2);

  await adapter.handleTurnLifecycleEvent?.({
    type: "finished",
    batchId: "batch-1",
    sources: [first],
    outcome: "cancelled",
    stopReason: "cancelled",
  });
  await adapter.handleTurnLifecycleEvent?.({
    type: "processing",
    batchId: "batch-2",
    sources: [second],
  });
  expect(bot?.api.sendChatAction).toHaveBeenCalledTimes(2);

  await adapter.handleTurnLifecycleEvent?.({
    type: "finished",
    batchId: "batch-2",
    sources: [otherTopic],
    outcome: "cancelled",
    stopReason: "cancelled",
  });
  await adapter.handleTurnLifecycleEvent?.({
    type: "processing",
    batchId: "batch-3",
    sources: [otherTopic],
  });
  expect(bot?.api.sendChatAction).toHaveBeenCalledTimes(3);
  expect(bot?.api.sendChatAction).toHaveBeenLastCalledWith("555", "typing", {
    message_thread_id: 8,
  });

  await adapter.handleTurnLifecycleEvent?.({
    type: "finished",
    batchId: "batch-4",
    sources: [second],
    outcome: "cancelled",
    stopReason: "cancelled",
  });
  await adapter.handleTurnLifecycleEvent?.({
    type: "processing",
    batchId: "batch-5",
    sources: [second],
  });
  expect(bot?.api.sendChatAction).toHaveBeenCalledTimes(4);
  expect(bot?.api.sendChatAction).toHaveBeenLastCalledWith("555", "typing", {
    message_thread_id: 7,
  });

  await adapter.stop();
});

test("telegram adapter ignores lifecycle events for non-telegram sources", async () => {
  const adapter = createTelegramAdapter({
    ...telegramAccountDefaults,
    channel: "telegram",
    enabled: true,
    token: "test-token",
    dmPolicy: "pairing",
    allowedUsers: [],
  });

  await adapter.start();

  await adapter.handleTurnLifecycleEvent?.({
    type: "queued",
    source: {
      channel: "slack",
      accountId: "slack-account",
      chatId: "C123",
      messageId: "1",
      threadId: null,
      agentId: "agent-1",
      conversationId: "conv-1",
    },
  });

  const bot = FakeBot.instances[0];
  expect(bot?.api.sendChatAction).not.toHaveBeenCalled();

  await adapter.stop();
});

test("telegram adapter keeps lifecycle ownership after sending a reaction", async () => {
  const adapter = createTelegramAdapter({
    ...telegramAccountDefaults,
    channel: "telegram",
    enabled: true,
    token: "test-token",
    dmPolicy: "pairing",
    allowedUsers: [],
  });

  await adapter.start();

  const turnSource = {
    channel: "telegram",
    accountId: "telegram-test-account",
    chatId: "555",
    chatType: "direct" as const,
    messageId: "42",
    threadId: null,
    agentId: "agent-1",
    conversationId: "conv-1",
  };

  await adapter.handleTurnLifecycleEvent?.({
    type: "processing",
    batchId: "batch-1",
    sources: [turnSource],
  });

  const bot = FakeBot.instances[0];
  expect(bot?.api.sendChatAction).toHaveBeenCalledTimes(1);

  await adapter.sendMessage({
    channel: "telegram",
    chatId: "555",
    text: "",
    reaction: "👍",
    targetMessageId: "42",
  });

  await adapter.handleTurnLifecycleEvent?.({
    type: "processing",
    batchId: "batch-2",
    sources: [turnSource],
  });

  expect(bot?.api.sendChatAction).toHaveBeenCalledTimes(1);

  await adapter.stop();
});

test("telegram adapter clears typing after sending control request prompt", async () => {
  const adapter = createTelegramAdapter({
    ...telegramAccountDefaults,
    channel: "telegram",
    enabled: true,
    token: "test-token",
    dmPolicy: "pairing",
    allowedUsers: [],
  });

  await adapter.start();

  const turnSource = {
    channel: "telegram",
    accountId: "telegram-test-account",
    chatId: "555",
    chatType: "direct" as const,
    messageId: "42",
    threadId: null,
    agentId: "agent-1",
    conversationId: "conv-1",
  };

  await adapter.handleTurnLifecycleEvent?.({
    type: "processing",
    batchId: "batch-1",
    sources: [turnSource],
  });

  const bot = FakeBot.instances[0];
  expect(bot?.api.sendChatAction).toHaveBeenCalledTimes(1);

  await adapter.handleControlRequestEvent?.({
    requestId: "req-1",
    kind: "generic_tool_approval",
    source: turnSource,
    toolName: "Shell",
    input: { command: "echo test" },
  });

  await adapter.handleTurnLifecycleEvent?.({
    type: "processing",
    batchId: "batch-2",
    sources: [turnSource],
  });

  expect(bot?.api.sendChatAction).toHaveBeenCalledTimes(2);

  await adapter.stop();
});
