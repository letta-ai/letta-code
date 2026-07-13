import { expect, test } from "bun:test";
import {
  bindChannelAccountLive,
  consoleErrorSpy,
  consoleWarnSpy,
  createChannelAccountLive,
  createConversation,
  createTelegramAdapter,
  FakeBot,
  FakeInputFile,
  getChannelAccountSnapshot,
  getChannelRegistry,
  getRoute,
  installTelegramAdapterTestHooks,
  setChannelConfigLive,
  startChannelAccountLive,
  telegramAccountDefaults,
} from "./telegram/adapter-test-harness";

installTelegramAdapterTestHooks();

test("telegram channel starts through service and routes inbound topic messages end-to-end", async () => {
  createChannelAccountLive(
    "telegram",
    {
      displayName: "Telegram E2E Bot",
      enabled: false,
      token: "test-token",
      dmPolicy: "pairing",
      groupMode: "open",
    },
    { accountId: "telegram-e2e" },
  );
  bindChannelAccountLive(
    "telegram",
    "telegram-e2e",
    "agent-telegram",
    "default",
  );

  const started = await startChannelAccountLive("telegram", "telegram-e2e");

  expect(started).toMatchObject({
    channelId: "telegram",
    accountId: "telegram-e2e",
    displayName: "Telegram E2E Bot",
    enabled: true,
    configured: true,
    running: true,
    binding: {
      agentId: "agent-telegram",
      conversationId: "default",
    },
  });
  expect(FakeBot.instances).toHaveLength(1);
  expect(FakeBot.instances[0]?.token).toBe("test-token");

  const registry = getChannelRegistry();
  expect(registry).not.toBeNull();
  const deliveries: unknown[] = [];
  registry?.setMessageHandler((delivery) => {
    deliveries.push(delivery);
  });
  registry?.setReady();

  await FakeBot.instances[0]?.emit("message", {
    message: {
      chat: { id: -100123, type: "supergroup", title: "Void Cafe" },
      message_thread_id: 42,
      from: { id: 456, username: "alice", first_name: "Alice" },
      text: "Hello from a Telegram topic",
      date: 1_736_380_800,
      message_id: 77,
    },
  });

  expect(createConversation).toHaveBeenCalledTimes(1);
  expect(createConversation).toHaveBeenCalledWith({
    agent_id: "agent-telegram",
    summary: "[Telegram] Topic in Void Cafe: Hello from a Telegram topic",
  });
  expect(getRoute("telegram", "-100123", "telegram-e2e", "42")).toMatchObject({
    accountId: "telegram-e2e",
    chatId: "-100123",
    chatType: "channel",
    threadId: "42",
    agentId: "agent-telegram",
    conversationId: "conv-telegram-e2e",
  });
  expect(deliveries).toHaveLength(1);
  expect(deliveries[0]).toMatchObject({
    route: {
      accountId: "telegram-e2e",
      agentId: "agent-telegram",
      conversationId: "conv-telegram-e2e",
    },
    turnSources: [
      {
        channel: "telegram",
        accountId: "telegram-e2e",
        chatId: "-100123",
        chatType: "channel",
        messageId: "77",
        threadId: "42",
        agentId: "agent-telegram",
        conversationId: "conv-telegram-e2e",
      },
    ],
  });
  const content = (deliveries[0] as { content: Array<{ text: string }> })
    .content;
  expect(content[0]?.text).toContain("external telegram turn");
  expect(content[1]?.text).toContain('source="telegram"');
  expect(content[1]?.text).toContain('chat_id="-100123"');
  expect(content[1]?.text).toContain('account_id="telegram-e2e"');
  expect(content[1]?.text).toContain('thread_id="42"');
  expect(content[1]?.text).toContain("Hello from a Telegram topic");
});

test("telegram channel account start rolls back enabled state when adapter startup fails", async () => {
  FakeBot.nextInitImpl = async () => {
    throw new Error("invalid Telegram token");
  };

  createChannelAccountLive(
    "telegram",
    {
      displayName: "Broken Telegram Bot",
      enabled: false,
      token: "bad-token",
      dmPolicy: "pairing",
    },
    { accountId: "telegram-broken" },
  );

  await expect(
    startChannelAccountLive("telegram", "telegram-broken"),
  ).rejects.toThrow("invalid Telegram token");

  expect(getChannelAccountSnapshot("telegram", "telegram-broken")).toEqual(
    expect.objectContaining({
      channelId: "telegram",
      accountId: "telegram-broken",
      enabled: false,
      running: false,
      configured: true,
    }),
  );
});

test("telegram channel routes permission prompts and approvals through the topic", async () => {
  createChannelAccountLive(
    "telegram",
    {
      displayName: "Telegram Permission Bot",
      enabled: false,
      token: "test-token",
      dmPolicy: "pairing",
      groupMode: "open",
    },
    { accountId: "telegram-permissions" },
  );
  bindChannelAccountLive(
    "telegram",
    "telegram-permissions",
    "agent-telegram",
    "default",
  );
  await startChannelAccountLive("telegram", "telegram-permissions");

  const registry = getChannelRegistry();
  if (!registry) {
    throw new Error("Expected Telegram channel registry to be initialized");
  }

  const deliveries: unknown[] = [];
  const approvalResponses: unknown[] = [];
  registry.setMessageHandler((delivery) => {
    deliveries.push(delivery);
  });
  registry.setApprovalResponseHandler(async (params) => {
    approvalResponses.push(params);
    return true;
  });
  registry.setReady();

  await registry.registerPendingControlRequest({
    requestId: "telegram-approval-1",
    kind: "generic_tool_approval",
    source: {
      channel: "telegram",
      accountId: "telegram-permissions",
      chatId: "-100123",
      chatType: "channel",
      messageId: "77",
      threadId: "42",
      agentId: "agent-telegram",
      conversationId: "conv-telegram-topic",
    },
    toolName: "Bash",
    input: {
      command: "npm test",
      description: "Run the test suite",
    },
  });

  const bot = FakeBot.instances[0];
  expect(bot).toBeDefined();
  expect(bot?.api.sendMessage).toHaveBeenCalledWith(
    "-100123",
    expect.stringContaining("The agent wants approval to run `Bash`."),
    {
      message_thread_id: 42,
      reply_parameters: { message_id: 42 },
    },
  );

  await bot?.emit("message", {
    message: {
      chat: { id: -100123, type: "supergroup", title: "Void Cafe" },
      message_thread_id: 42,
      from: { id: 456, username: "alice", first_name: "Alice" },
      text: "approve",
      date: 1_736_380_801,
      message_id: 78,
    },
  });

  expect(deliveries).toHaveLength(0);
  expect(approvalResponses).toEqual([
    {
      runtime: {
        agent_id: "agent-telegram",
        conversation_id: "conv-telegram-topic",
      },
      response: {
        request_id: "telegram-approval-1",
        decision: {
          behavior: "allow",
        },
      },
    },
  ]);
  expect(registry.getPendingControlRequests()).toHaveLength(0);
});

test("telegram channel modifies config while running and keeps the adapter live", async () => {
  createChannelAccountLive(
    "telegram",
    {
      displayName: "Telegram Running Bot",
      enabled: false,
      token: "test-token",
      dmPolicy: "pairing",
      groupMode: "open",
      transcribeVoice: false,
      richDraftStreaming: false,
      inboundDebounceMs: 100,
    },
    { accountId: "telegram-running-config" },
  );
  bindChannelAccountLive(
    "telegram",
    "telegram-running-config",
    "agent-telegram",
    "default",
  );

  const started = await startChannelAccountLive(
    "telegram",
    "telegram-running-config",
  );
  expect(started).toMatchObject({
    enabled: true,
    running: true,
  });
  expect(FakeBot.instances).toHaveLength(1);

  const updated = await setChannelConfigLive(
    "telegram",
    {
      dmPolicy: "allowlist",
      allowedUsers: ["456"],
      config: {
        group_mode: "mention-only",
        transcribe_voice: true,
        rich_private_chat_default: false,
        rich_draft_streaming: true,
        inbound_debounce_ms: 750,
      },
    },
    "telegram-running-config",
  );

  expect(updated).toMatchObject({
    channelId: "telegram",
    accountId: "telegram-running-config",
    displayName: "Telegram Running Bot",
    enabled: true,
    dmPolicy: "allowlist",
    allowedUsers: ["456"],
    config: {
      has_token: true,
      group_mode: "mention-only",
      transcribe_voice: true,
      rich_private_chat_default: false,
      rich_draft_streaming: true,
      inbound_debounce_ms: 750,
      binding: {
        agent_id: "agent-telegram",
        conversation_id: "default",
      },
    },
  });
  expect(
    getChannelAccountSnapshot("telegram", "telegram-running-config"),
  ).toMatchObject({
    enabled: true,
    running: true,
    dmPolicy: "allowlist",
    allowedUsers: ["456"],
    richPrivateChatDefault: false,
    richDraftStreaming: true,
  });
  expect(FakeBot.instances).toHaveLength(2);
  expect(FakeBot.instances[1]?.token).toBe("test-token");
});

test("telegram adapter logs unhandled grammY errors with update context", async () => {
  const adapter = createTelegramAdapter({
    ...telegramAccountDefaults,
    channel: "telegram",
    enabled: true,
    token: "test-token",
    dmPolicy: "pairing",
    allowedUsers: [],
  });

  await adapter.start();

  const bot = FakeBot.instances[0];
  expect(bot).toBeDefined();
  expect(bot?.catchHandler).not.toBeNull();

  const error = new Error("middleware boom");
  bot?.catchHandler?.({
    ctx: { update: { update_id: 42 } },
    error,
  });

  expect(consoleErrorSpy).toHaveBeenCalledWith(
    "[Telegram] Unhandled bot error for update 42:",
    error,
  );
});

test("telegram adapter start waits until polling is live before resolving", async () => {
  let releaseStart: (() => Promise<void>) | undefined;

  FakeBot.nextStartImpl = async (options, botInfo) => {
    await new Promise<void>((resolve) => {
      releaseStart = async () => {
        await options?.onStart?.(
          botInfo ?? {
            username: "test_bot",
            id: 12345,
          },
        );
        resolve();
      };
    });
  };

  const adapter = createTelegramAdapter({
    ...telegramAccountDefaults,
    channel: "telegram",
    enabled: true,
    token: "test-token",
    dmPolicy: "pairing",
    allowedUsers: [],
  });

  const startPromise = adapter.start();
  expect(adapter.isRunning()).toBe(false);

  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(releaseStart).toBeDefined();
  const triggerStart = releaseStart;
  if (!triggerStart) {
    throw new Error("Expected start callback to be registered");
  }
  await triggerStart();
  await startPromise;

  expect(adapter.isRunning()).toBe(true);
});

test("telegram adapter logs and clears running state when polling exits unexpectedly", async () => {
  FakeBot.nextStartImpl = async (options, botInfo) => {
    await options?.onStart?.(
      botInfo ?? {
        username: "test_bot",
        id: 12345,
      },
    );
    throw new Error("polling failed");
  };

  const adapter = createTelegramAdapter({
    ...telegramAccountDefaults,
    channel: "telegram",
    enabled: true,
    token: "test-token",
    dmPolicy: "pairing",
    allowedUsers: [],
  });

  await adapter.start();
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(adapter.isRunning()).toBe(false);
  expect(consoleErrorSpy).toHaveBeenCalledWith(
    "[Telegram] Long-polling stopped unexpectedly:",
    expect.objectContaining({ message: "polling failed" }),
  );
});

test("telegram adapter rejects startup when polling never becomes live", async () => {
  const originalStartTimeout = process.env.LETTA_TELEGRAM_START_TIMEOUT_MS;
  process.env.LETTA_TELEGRAM_START_TIMEOUT_MS = "20";
  FakeBot.nextStartImpl = async () => {
    await new Promise(() => undefined);
  };

  const adapter = createTelegramAdapter({
    ...telegramAccountDefaults,
    channel: "telegram",
    enabled: true,
    token: "test-token",
    dmPolicy: "pairing",
    allowedUsers: [],
  });

  try {
    await expect(adapter.start()).rejects.toThrow(
      "Telegram bot polling start timed out after 20ms",
    );
    expect(adapter.isRunning()).toBe(false);
  } finally {
    if (originalStartTimeout === undefined) {
      delete process.env.LETTA_TELEGRAM_START_TIMEOUT_MS;
    } else {
      process.env.LETTA_TELEGRAM_START_TIMEOUT_MS = originalStartTimeout;
    }
  }
});

test("telegram adapter emits startup logger milestones", async () => {
  const logs: string[] = [];
  const adapter = createTelegramAdapter({
    ...telegramAccountDefaults,
    channel: "telegram",
    enabled: true,
    token: "test-token",
    dmPolicy: "pairing",
    allowedUsers: [],
  });

  await adapter.start({ logger: (message) => logs.push(message) });

  expect(logs).toContain(
    "[Telegram] start requested for account telegram-test-account",
  );
  expect(logs).toContain("[Telegram] loading grammY runtime");
  expect(logs).toContain(
    "[Telegram] polling ready for account telegram-test-account",
  );
});

test("telegram adapter forwards parse mode and reply parameters", async () => {
  const adapter = createTelegramAdapter({
    ...telegramAccountDefaults,
    channel: "telegram",
    enabled: true,
    token: "test-token",
    dmPolicy: "pairing",
    allowedUsers: [],
  });

  await adapter.start();
  await adapter.sendMessage({
    channel: "telegram",
    chatId: "123",
    text: "<b>hello</b>",
    replyToMessageId: "456",
    parseMode: "HTML",
  });

  const bot = FakeBot.instances[0];
  expect(bot).toBeDefined();
  expect(bot?.api.sendMessage).toHaveBeenCalledWith("123", "<b>hello</b>", {
    parse_mode: "HTML",
    reply_parameters: { message_id: 456 },
  });
});

test("telegram adapter omits message_thread_id for root private chats", async () => {
  const adapter = createTelegramAdapter({
    ...telegramAccountDefaults,
    channel: "telegram",
    enabled: true,
    token: "test-token",
    dmPolicy: "pairing",
    allowedUsers: [],
  });

  await adapter.start();
  await adapter.sendMessage({
    channel: "telegram",
    chatId: "123",
    text: "<b>hello private</b>",
    parseMode: "HTML",
  });

  const bot = FakeBot.instances[0];
  expect(bot).toBeDefined();
  expect(bot?.api.sendMessage).toHaveBeenCalledWith(
    "123",
    "<b>hello private</b>",
    {
      parse_mode: "HTML",
    },
  );
});

test("telegram adapter sends messages into private bot topics", async () => {
  const adapter = createTelegramAdapter({
    ...telegramAccountDefaults,
    channel: "telegram",
    enabled: true,
    token: "test-token",
    dmPolicy: "pairing",
    allowedUsers: [],
  });

  await adapter.start();
  await adapter.sendMessage({
    channel: "telegram",
    chatId: "123",
    text: "<b>hello private topic</b>",
    threadId: "42",
    parseMode: "HTML",
  });

  const bot = FakeBot.instances[0];
  expect(bot).toBeDefined();
  expect(bot?.api.sendMessage).toHaveBeenCalledWith(
    "123",
    "<b>hello private topic</b>",
    {
      message_thread_id: 42,
      parse_mode: "HTML",
    },
  );
});

test("telegram adapter sends direct replies into private bot topics", async () => {
  const adapter = createTelegramAdapter({
    ...telegramAccountDefaults,
    channel: "telegram",
    enabled: true,
    token: "test-token",
    dmPolicy: "pairing",
    allowedUsers: [],
  });

  await adapter.start();
  await adapter.sendDirectReply("123", "pairing reply", {
    replyToMessageId: "77",
    threadId: "42",
  });

  const bot = FakeBot.instances[0];
  expect(bot).toBeDefined();
  expect(bot?.api.sendMessage).toHaveBeenCalledWith("123", "pairing reply", {
    message_thread_id: 42,
    reply_parameters: { message_id: 77 },
  });
});

test("telegram adapter sends messages into forum topics", async () => {
  const adapter = createTelegramAdapter({
    ...telegramAccountDefaults,
    channel: "telegram",
    enabled: true,
    token: "test-token",
    dmPolicy: "pairing",
    allowedUsers: [],
  });

  await adapter.start();
  await adapter.sendMessage({
    channel: "telegram",
    chatId: "-100123",
    text: "<b>hello topic</b>",
    threadId: "42",
    parseMode: "HTML",
  });

  const bot = FakeBot.instances[0];
  expect(bot).toBeDefined();
  expect(bot?.api.sendMessage).toHaveBeenCalledWith(
    "-100123",
    "<b>hello topic</b>",
    {
      message_thread_id: 42,
      parse_mode: "HTML",
    },
  );
});

test("telegram adapter sends rich messages through the raw Bot API", async () => {
  const adapter = createTelegramAdapter({
    ...telegramAccountDefaults,
    channel: "telegram",
    enabled: true,
    token: "test-token",
    dmPolicy: "pairing",
    allowedUsers: [],
  });

  await adapter.start();
  await adapter.sendMessage({
    channel: "telegram",
    chatId: "-100123",
    text: "<b>fallback</b>",
    parseMode: "HTML",
    replyToMessageId: "456",
    threadId: "42",
    richMessage: { markdown: "# Title\n\n- item" },
  });

  const bot = FakeBot.instances[0];
  expect(bot?.api.raw.sendRichMessage).toHaveBeenCalledWith({
    chat_id: "-100123",
    message_thread_id: 42,
    reply_parameters: { message_id: 456 },
    rich_message: { markdown: "# Title\n\n- item" },
  });
  expect(bot?.api.sendMessage).not.toHaveBeenCalled();
});

test("telegram adapter streams rich message drafts through the raw Bot API", async () => {
  const adapter = createTelegramAdapter({
    ...telegramAccountDefaults,
    channel: "telegram",
    enabled: true,
    token: "test-token",
    dmPolicy: "pairing",
    allowedUsers: [],
  });

  await adapter.start();
  await adapter.sendRichMessageDraft?.({
    channel: "telegram",
    chatId: "-100123",
    threadId: "42",
    draftId: 8765,
    richMessage: { markdown: "# Draft\n\nStill thinking" },
  });

  const bot = FakeBot.instances[0];
  expect(bot?.api.raw.sendRichMessageDraft).toHaveBeenCalledWith({
    chat_id: "-100123",
    message_thread_id: 42,
    draft_id: 8765,
    rich_message: { markdown: "# Draft\n\nStill thinking" },
  });
});

test("telegram adapter falls back to sendMessage when rich parsing fails", async () => {
  const adapter = createTelegramAdapter({
    ...telegramAccountDefaults,
    channel: "telegram",
    enabled: true,
    token: "test-token",
    dmPolicy: "pairing",
    allowedUsers: [],
  });

  await adapter.start();
  const bot = FakeBot.instances[0];
  bot?.api.raw.sendRichMessage.mockRejectedValueOnce(
    new Error("Bad Request: can't parse entities"),
  );

  await adapter.sendMessage({
    channel: "telegram",
    chatId: "-100123",
    text: "<b>fallback</b>",
    parseMode: "HTML",
    replyToMessageId: "456",
    threadId: "42",
    richMessage: { markdown: "# Title\n\n- item" },
  });

  expect(bot?.api.sendMessage).toHaveBeenCalledWith(
    "-100123",
    "<b>fallback</b>",
    {
      message_thread_id: 42,
      parse_mode: "HTML",
      reply_parameters: { message_id: 456 },
    },
  );
  expect(consoleWarnSpy).toHaveBeenCalledWith(
    "[Telegram] sendRichMessage failed; falling back to sendMessage:",
    "Bad Request: can't parse entities",
  );
});

test("telegram adapter does not fallback on ambiguous rich send failures", async () => {
  const adapter = createTelegramAdapter({
    ...telegramAccountDefaults,
    channel: "telegram",
    enabled: true,
    token: "test-token",
    dmPolicy: "pairing",
    allowedUsers: [],
  });

  await adapter.start();
  const bot = FakeBot.instances[0];
  bot?.api.raw.sendRichMessage.mockRejectedValueOnce(
    new Error("network timeout after request dispatch"),
  );

  await expect(
    adapter.sendMessage({
      channel: "telegram",
      chatId: "123",
      text: "<b>fallback</b>",
      parseMode: "HTML",
      richMessage: { markdown: "# Title" },
    }),
  ).rejects.toThrow("network timeout after request dispatch");

  expect(bot?.api.sendMessage).not.toHaveBeenCalled();
});

test("telegram adapter does not fallback when rich send targets a bad thread", async () => {
  const adapter = createTelegramAdapter({
    ...telegramAccountDefaults,
    channel: "telegram",
    enabled: true,
    token: "test-token",
    dmPolicy: "pairing",
    allowedUsers: [],
  });

  await adapter.start();
  const bot = FakeBot.instances[0];
  bot?.api.raw.sendRichMessage.mockRejectedValueOnce(
    new Error("Bad Request: message thread not found"),
  );

  await expect(
    adapter.sendMessage({
      channel: "telegram",
      chatId: "-100123",
      text: "<b>fallback</b>",
      parseMode: "HTML",
      threadId: "999",
      richMessage: { markdown: "# Title" },
    }),
  ).rejects.toThrow("Bad Request: message thread not found");

  expect(bot?.api.sendMessage).not.toHaveBeenCalled();
});

test("telegram adapter uploads outbound media with a caption", async () => {
  const adapter = createTelegramAdapter({
    ...telegramAccountDefaults,
    channel: "telegram",
    enabled: true,
    token: "test-token",
    dmPolicy: "pairing",
    allowedUsers: [],
  });

  await adapter.start();
  await adapter.sendMessage({
    channel: "telegram",
    chatId: "-100123",
    text: "<b>see image</b>",
    parseMode: "HTML",
    replyToMessageId: "456",
    threadId: "42",
    mediaPath: "/tmp/screenshot.png",
    fileName: "screenshot.png",
    title: "Screenshot",
  });

  const bot = FakeBot.instances[0];
  expect(bot?.api.sendPhoto).toHaveBeenCalledWith(
    "-100123",
    expect.any(FakeInputFile),
    {
      caption: "<b>see image</b>",
      message_thread_id: 42,
      parse_mode: "HTML",
      reply_parameters: { message_id: 456 },
      title: "Screenshot",
    },
  );
});

test("telegram adapter can add reactions to messages", async () => {
  const adapter = createTelegramAdapter({
    ...telegramAccountDefaults,
    channel: "telegram",
    enabled: true,
    token: "test-token",
    dmPolicy: "pairing",
    allowedUsers: [],
  });

  await adapter.start();
  await adapter.sendMessage({
    channel: "telegram",
    chatId: "123",
    text: "",
    reaction: "👍",
    targetMessageId: "456",
  });

  const bot = FakeBot.instances[0];
  expect(bot?.api.setMessageReaction).toHaveBeenCalledWith("123", 456, [
    { type: "emoji", emoji: "👍" },
  ]);
});
