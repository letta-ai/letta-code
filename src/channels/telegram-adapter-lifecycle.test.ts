import { expect, mock, test } from "bun:test";
import {
  __testOverrideSubmitChannelLifecycleErrorReport,
  createTelegramAdapter,
  FakeBot,
  installTelegramAdapterTestHooks,
  telegramAccountDefaults,
} from "./telegram/adapter-test-harness";

installTelegramAdapterTestHooks();

test("telegram adapter replies with lifecycle errors", async () => {
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
    type: "finished",
    batchId: "batch-1",
    outcome: "error",
    stopReason: "error",
    error: "ChatGPT usage limit reached. Resets at 1:00 PM.",
    sources: [
      {
        channel: "telegram",
        accountId: "telegram-test-account",
        chatId: "123",
        chatType: "direct",
        messageId: "77",
        threadId: null,
        agentId: "agent-1",
        conversationId: "conv-1",
      },
    ],
  });

  const bot = FakeBot.instances[0];
  expect(bot?.api.sendMessage).toHaveBeenCalledWith(
    "123",
    "Turn failed:\nChatGPT usage limit reached. Resets at 1:00 PM.",
    expect.objectContaining({
      reply_parameters: { message_id: 77 },
      reply_markup: {
        inline_keyboard: [
          [
            expect.objectContaining({
              text: "Report error",
              callback_data: expect.stringMatching(/^lc_report:/),
            }),
          ],
        ],
      },
    }),
  );
});

test("telegram lifecycle errors omit stale thread ids for private chats", async () => {
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
    type: "finished",
    batchId: "batch-1",
    outcome: "error",
    stopReason: "error",
    error: "Something failed.",
    sources: [
      {
        channel: "telegram",
        accountId: "telegram-test-account",
        chatId: "123",
        chatType: "direct",
        messageId: "77",
        threadId: "42",
        agentId: "agent-1",
        conversationId: "conv-1",
      },
    ],
  });

  const bot = FakeBot.instances[0];
  expect(bot?.api.sendMessage).toHaveBeenCalledWith(
    "123",
    "Turn failed:\nSomething failed.",
    expect.not.objectContaining({
      message_thread_id: expect.anything(),
    }),
  );
  expect(bot?.api.sendMessage).toHaveBeenCalledWith(
    "123",
    "Turn failed:\nSomething failed.",
    expect.objectContaining({
      reply_parameters: { message_id: 77 },
    }),
  );
});

test("telegram adapter hides raw generic lifecycle errors", async () => {
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
    type: "finished",
    batchId: "batch-1",
    outcome: "error",
    stopReason: "error",
    error: "Unexpected stop reason: error",
    sources: [
      {
        channel: "telegram",
        accountId: "telegram-test-account",
        chatId: "123",
        chatType: "direct",
        messageId: "77",
        threadId: null,
        agentId: "agent-1",
        conversationId: "conv-1",
      },
    ],
  });

  const bot = FakeBot.instances[0];
  expect(bot?.api.sendMessage).toHaveBeenCalledWith(
    "123",
    "Turn failed:\nSomething went wrong while processing that message. Please try again.",
    expect.objectContaining({
      reply_parameters: { message_id: 77 },
      reply_markup: {
        inline_keyboard: [
          [
            expect.objectContaining({
              text: "Report error",
              callback_data: expect.stringMatching(/^lc_report:/),
            }),
          ],
        ],
      },
    }),
  );
});

test("telegram adapter prettifies conversation-busy lifecycle errors", async () => {
  const adapter = createTelegramAdapter({
    ...telegramAccountDefaults,
    channel: "telegram",
    enabled: true,
    token: "test-token",
    dmPolicy: "pairing",
    allowedUsers: [],
  });

  const rawError = [
    JSON.stringify({
      error: {
        detail:
          "CONFLICT: Cannot send a new message: Another request is currently being processed for this conversation.",
        run_id: "run-123",
      },
    }),
    "View agent: \x1b]8;;https://chat.letta.com/chat/agent-1?conversation=conv-1\x1b\\agent-1\x1b]8;;\x1b\\ (run: run-123)",
  ].join("\n");

  await adapter.start();
  await adapter.handleTurnLifecycleEvent?.({
    type: "finished",
    batchId: "batch-1",
    outcome: "error",
    stopReason: "error",
    error: rawError,
    sources: [
      {
        channel: "telegram",
        accountId: "telegram-test-account",
        chatId: "123",
        chatType: "direct",
        messageId: "77",
        threadId: null,
        agentId: "agent-1",
        conversationId: "conv-1",
      },
    ],
  });

  const bot = FakeBot.instances[0];
  const sendMessageCall = bot?.api.sendMessage.mock.calls[0] as
    | unknown[]
    | undefined;
  const message = sendMessageCall?.[1] as string | undefined;
  expect(message).toBe(
    "Turn still running\n" +
      "Another request is already processing for this conversation. Please wait for it to finish, then try again.\n\n" +
      "Run ID: run-123",
  );
  expect(message).not.toContain("app.letta.com");
  expect(message).not.toContain("\x1b");
});

test("telegram lifecycle report button submits sanitized error metadata", async () => {
  const reports: unknown[] = [];
  __testOverrideSubmitChannelLifecycleErrorReport(async (report) => {
    reports.push(report);
  });

  const adapter = createTelegramAdapter({
    ...telegramAccountDefaults,
    channel: "telegram",
    enabled: true,
    token: "test-token",
    dmPolicy: "pairing",
    allowedUsers: [],
  });

  const rawError = [
    JSON.stringify({
      error: {
        detail:
          "CONFLICT: Cannot send a new message: Another request is currently being processed for this conversation.",
        run_id: "run-456",
      },
    }),
    "View agent: \x1b]8;;https://chat.letta.com/chat/agent-1?conversation=conv-1\x1b\\agent-1\x1b]8;;\x1b\\ (run: run-456)",
  ].join("\n");

  await adapter.start();
  await adapter.handleTurnLifecycleEvent?.({
    type: "finished",
    batchId: "batch-1",
    outcome: "error",
    stopReason: "error",
    error: rawError,
    sources: [
      {
        channel: "telegram",
        accountId: "telegram-test-account",
        chatId: "123",
        chatType: "direct",
        messageId: "77",
        threadId: null,
        agentId: "agent-1",
        conversationId: "conv-1",
      },
    ],
  });

  const bot = FakeBot.instances[0];
  const sendMessageCall = bot?.api.sendMessage.mock.calls[0] as
    | unknown[]
    | undefined;
  const options = sendMessageCall?.[2] as
    | {
        reply_markup?: {
          inline_keyboard?: Array<Array<{ callback_data?: string }>>;
        };
      }
    | undefined;
  const callbackData =
    options?.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data;
  if (!callbackData) {
    throw new Error("Missing lifecycle report callback data");
  }

  const answerCallbackQuery = mock(async () => {});
  await bot?.emit("callback_query", {
    callbackQuery: { data: callbackData },
    answerCallbackQuery,
  });

  expect(reports).toEqual([
    expect.objectContaining({
      channel: "telegram",
      accountId: "telegram-test-account",
      agentId: "agent-1",
      conversationId: "conv-1",
      runId: "run-456",
      errorKind: "conversation_busy",
      errorMessage:
        "Another request is already processing for this conversation. Please wait for it to finish, then try again.",
    }),
  ]);
  expect(JSON.stringify(reports[0])).not.toContain("app.letta.com");
  expect(answerCallbackQuery).toHaveBeenCalledWith({
    text: "Error report sent. Thanks.",
    show_alert: false,
  });
});

test("telegram adapter does not send lifecycle replies for completed turns", async () => {
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
    type: "finished",
    batchId: "batch-1",
    outcome: "completed",
    stopReason: "end_turn",
    sources: [
      {
        channel: "telegram",
        accountId: "telegram-test-account",
        chatId: "123",
        chatType: "direct",
        messageId: "77",
        threadId: null,
        agentId: "agent-1",
        conversationId: "conv-1",
      },
    ],
  });

  const bot = FakeBot.instances[0];
  expect(bot?.api.sendMessage).not.toHaveBeenCalled();
});

test("telegram adapter deduplicates lifecycle error replies", async () => {
  const adapter = createTelegramAdapter({
    ...telegramAccountDefaults,
    channel: "telegram",
    enabled: true,
    token: "test-token",
    dmPolicy: "pairing",
    allowedUsers: [],
  });

  const event = {
    type: "finished" as const,
    batchId: "batch-1",
    outcome: "error" as const,
    stopReason: "error" as const,
    error: "Usage limit reached.",
    sources: [
      {
        channel: "telegram",
        accountId: "telegram-test-account",
        chatId: "123",
        chatType: "direct" as const,
        messageId: "77",
        threadId: null,
        agentId: "agent-1",
        conversationId: "conv-1",
      },
    ],
  };

  await adapter.start();
  await adapter.handleTurnLifecycleEvent?.(event);
  await adapter.handleTurnLifecycleEvent?.(event);

  const bot = FakeBot.instances[0];
  expect(bot?.api.sendMessage).toHaveBeenCalledTimes(1);
});

test("telegram adapter forwards reaction updates through onMessage", async () => {
  const adapter = createTelegramAdapter({
    ...telegramAccountDefaults,
    channel: "telegram",
    enabled: true,
    token: "test-token",
    dmPolicy: "pairing",
    allowedUsers: [],
  });

  const onMessage = mock(async () => {});
  adapter.onMessage = onMessage;

  await adapter.start();

  const bot = FakeBot.instances[0];
  await bot?.emit("message_reaction", {
    messageReaction: {
      chat: { id: 123, type: "private" },
      user: { id: 456, username: "alice", first_name: "Alice" },
      date: 1_736_380_800,
      message_id: 77,
      old_reaction: [],
      new_reaction: [{ type: "emoji", emoji: "👍" }],
    },
  });

  expect(onMessage).toHaveBeenCalledWith({
    channel: "telegram",
    accountId: "telegram-test-account",
    chatId: "123",
    senderId: "456",
    senderName: "alice",
    text: "Telegram reaction added: 👍",
    timestamp: 1_736_380_800_000,
    messageId: "77",
    chatType: "direct",
    reaction: {
      action: "added",
      emoji: "👍",
      targetMessageId: "77",
    },
    raw: expect.objectContaining({ message_id: 77 }),
  });
});
