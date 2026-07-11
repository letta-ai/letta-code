import { expect, test } from "bun:test";
import {
  createTelegramAdapter,
  FakeBot,
  installTelegramAdapterTestHooks,
  telegramAccountDefaults,
} from "./telegram/adapter-test-harness";

installTelegramAdapterTestHooks();

test("telegram adapter sends typing chat action while a turn is processing", async () => {
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
  expect(bot?.api.sendChatAction).not.toHaveBeenCalled();

  await adapter.handleTurnLifecycleEvent?.({
    type: "processing",
    batchId: "batch-1",
    sources: [turnSource],
  });

  expect(bot?.api.sendChatAction).toHaveBeenCalledWith("555", "typing");
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

test("telegram adapter stops refreshing typing after sending a message", async () => {
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
    batchId: "batch-2",
    sources: [turnSource],
  });

  expect(bot?.api.sendChatAction).toHaveBeenCalledTimes(2);

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

test("telegram adapter clears typing after sending a reaction", async () => {
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

  expect(bot?.api.sendChatAction).toHaveBeenCalledTimes(2);

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

test("telegram control prompts target private bot topics", async () => {
  const adapter = createTelegramAdapter({
    ...telegramAccountDefaults,
    channel: "telegram",
    enabled: true,
    token: "test-token",
    dmPolicy: "pairing",
    allowedUsers: [],
  });

  await adapter.start();

  await adapter.handleControlRequestEvent?.({
    requestId: "req-1",
    kind: "generic_tool_approval",
    source: {
      channel: "telegram",
      accountId: "telegram-test-account",
      chatId: "555",
      chatType: "direct",
      messageId: "42",
      threadId: "99",
      agentId: "agent-1",
      conversationId: "conv-1",
    },
    toolName: "Shell",
    input: { command: "echo test" },
  });

  const bot = FakeBot.instances[0];
  expect(bot?.api.sendMessage).toHaveBeenCalledWith(
    "555",
    expect.stringContaining("Shell"),
    expect.objectContaining({
      message_thread_id: 99,
      reply_parameters: { message_id: 99 },
    }),
  );
});
