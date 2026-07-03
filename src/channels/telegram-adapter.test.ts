import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { clearChannelAccountStores } from "@/channels/accounts";
import { __testOverrideChannelsRoot } from "@/channels/config";
import { __setActiveChannelCredentialsStoreModeForTests } from "@/channels/credential-store";
import { clearPairingStores } from "@/channels/pairing";
import { clearPendingControlRequestStore } from "@/channels/pending-control-requests";
import { clearAllRoutes, getRoute } from "@/channels/routing";
import { clearTargetStores } from "@/channels/targets";
import type { InboundChannelMessage } from "@/channels/types";

type FakeBotStartOptions = {
  onStart?: (botInfo: {
    username?: string;
    id: number;
  }) => void | Promise<void>;
  allowed_updates?: string[];
};

type FakeHandler = (ctx: unknown) => unknown | Promise<unknown>;

let channelRoot = join(tmpdir(), "letta-telegram-test-root");

class FakeInputFile {
  readonly file: string;
  readonly filename?: string;

  constructor(file: string, filename?: string) {
    this.file = file;
    this.filename = filename;
  }
}

class FakeBot {
  static instances: FakeBot[] = [];
  static nextInitImpl: () => Promise<void> = async () => {};
  static nextStartImpl: (
    options?: FakeBotStartOptions,
    botInfo?: { username?: string; id: number },
  ) => Promise<void> = async (options, botInfo) => {
    await options?.onStart?.(
      botInfo ?? {
        username: "test_bot",
        id: 12345,
      },
    );
  };
  static nextGetFileImpl: (fileId: string) => Promise<{ file_path?: string }> =
    async (fileId) => ({
      file_path: `photos/${fileId}.jpg`,
    });

  readonly token: string;
  botInfo = { username: "test_bot", id: 12345 };
  readonly handlers = new Map<string, FakeHandler[]>();
  readonly api = {
    sendMessage: mock(async () => ({ message_id: 999 })),
    setMessageReaction: mock(async () => true),
    sendPhoto: mock(async () => ({ message_id: 1001 })),
    sendDocument: mock(async () => ({ message_id: 1002 })),
    sendVideo: mock(async () => ({ message_id: 1003 })),
    sendAudio: mock(async () => ({ message_id: 1004 })),
    sendVoice: mock(async () => ({ message_id: 1005 })),
    sendAnimation: mock(async () => ({ message_id: 1006 })),
    sendChatAction: mock(async () => true),
    getFile: mock(async (fileId: string) => FakeBot.nextGetFileImpl(fileId)),
    raw: {
      sendRichMessage: mock(async () => ({ message_id: 2001 })),
      sendRichMessageDraft: mock(async () => true),
    },
  };
  catchHandler:
    | ((error: {
        ctx?: { update?: { update_id?: number } };
        error: unknown;
      }) => unknown)
    | null = null;

  constructor(token: string) {
    this.token = token;
    FakeBot.instances.push(this);
  }

  on(event: string, handler: FakeHandler): this {
    const existing = this.handlers.get(event) ?? [];
    existing.push(handler);
    this.handlers.set(event, existing);
    return this;
  }

  command(_command: string, _handler: FakeHandler): this {
    return this;
  }

  async init(): Promise<void> {
    return FakeBot.nextInitImpl();
  }

  start(options?: FakeBotStartOptions): Promise<void> {
    return FakeBot.nextStartImpl(options, this.botInfo);
  }

  async stop(): Promise<void> {}

  catch(
    handler: (error: {
      ctx?: { update?: { update_id?: number } };
      error: unknown;
    }) => unknown,
  ): void {
    this.catchHandler = handler;
  }

  async emit(event: string, ctx: unknown): Promise<void> {
    const handlers = this.handlers.get(event) ?? [];
    for (const handler of handlers) {
      await handler(ctx);
    }
  }
}

mock.module("./telegram/runtime", () => ({
  ensureTelegramRuntimeInstalled: async () => false,
  installTelegramRuntime: async () => {},
  isTelegramRuntimeInstalled: () => true,
  loadGrammyModule: async () => ({
    Bot: FakeBot,
    InputFile: FakeInputFile,
  }),
}));

const createConversation = mock(async () => ({ id: "conv-telegram-e2e" }));

mock.module("@/backend/api/client", () => ({
  getServerUrl: () => "https://api.letta.com",
  getClient: async () => ({
    conversations: {
      create: createConversation,
    },
  }),
}));

const { __testOverrideSubmitChannelLifecycleErrorReport } = await import(
  "@/channels/lifecycle-error-report"
);
const { createTelegramAdapter, detectTelegramBotMention } = await import(
  "@/channels/telegram/adapter"
);
const { MAX_TELEGRAM_DOWNLOAD_BYTES } = await import(
  "@/channels/telegram/media"
);
const {
  bindChannelAccountLive,
  createChannelAccountLive,
  getChannelAccountSnapshot,
  setChannelConfigLive,
  startChannelAccountLive,
} = await import("@/channels/service");
const { getChannelRegistry } = await import("@/channels/registry");

const telegramAccountDefaults = {
  accountId: "telegram-test-account",
  displayName: "@test_bot",
  binding: {
    agentId: null,
    conversationId: null,
  },
  createdAt: "2026-04-11T00:00:00.000Z",
  updatedAt: "2026-04-11T00:00:00.000Z",
} as const;

const consoleErrorSpy = mock(() => {});
const consoleWarnSpy = mock(() => {});
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;
const originalFetch = globalThis.fetch;
const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
const originalTelegramDebounce = process.env.LETTA_TELEGRAM_INBOUND_DEBOUNCE_MS;

beforeEach(() => {
  channelRoot = mkdtempSync(join(tmpdir(), "letta-telegram-root-"));
  __testOverrideChannelsRoot(channelRoot);
  clearChannelAccountStores();
  clearAllRoutes();
  clearPairingStores();
  clearPendingControlRequestStore();
  clearTargetStores();
  __setActiveChannelCredentialsStoreModeForTests("file");
  createConversation.mockReset();
  createConversation.mockResolvedValue({ id: "conv-telegram-e2e" });
  FakeBot.instances.length = 0;
  FakeBot.nextInitImpl = async () => {};
  FakeBot.nextStartImpl = async (options, botInfo) => {
    await options?.onStart?.(
      botInfo ?? {
        username: "test_bot",
        id: 12345,
      },
    );
  };
  FakeBot.nextGetFileImpl = async (fileId) => ({
    file_path: `photos/${fileId}.jpg`,
  });
  consoleErrorSpy.mockClear();
  consoleWarnSpy.mockClear();
  console.error = consoleErrorSpy as typeof console.error;
  console.warn = consoleWarnSpy as typeof console.warn;
  globalThis.fetch = originalFetch;
  __testOverrideSubmitChannelLifecycleErrorReport(null);
  delete process.env.OPENAI_API_KEY;
});

afterEach(async () => {
  const registry = getChannelRegistry();
  if (registry) {
    await registry.stopAll();
  }
  clearChannelAccountStores();
  clearAllRoutes();
  clearPairingStores();
  clearPendingControlRequestStore();
  clearTargetStores();
  __testOverrideChannelsRoot(null);
  __setActiveChannelCredentialsStoreModeForTests(null);
  console.error = originalConsoleError;
  console.warn = originalConsoleWarn;
  globalThis.fetch = originalFetch;
  __testOverrideSubmitChannelLifecycleErrorReport(null);
  if (originalOpenAiApiKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = originalOpenAiApiKey;
  }
  if (originalTelegramDebounce === undefined) {
    delete process.env.LETTA_TELEGRAM_INBOUND_DEBOUNCE_MS;
  } else {
    process.env.LETTA_TELEGRAM_INBOUND_DEBOUNCE_MS = originalTelegramDebounce;
  }
  rmSync(channelRoot, { recursive: true, force: true });
});

afterAll(() => {
  mock.restore();
});

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

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
  expect(createConversation).toHaveBeenCalledWith(
    {
      agent_id: "agent-telegram",
      summary: "[Telegram] Topic in Void Cafe: Hello from a Telegram topic",
    },
    undefined,
  );
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
    text: "<b>hello private root</b>",
    parseMode: "HTML",
  });

  const bot = FakeBot.instances[0];
  expect(bot).toBeDefined();
  expect(bot?.api.sendMessage).toHaveBeenCalledWith(
    "123",
    "<b>hello private root</b>",
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

test("telegram adapter forwards plain text messages through onMessage", async () => {
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
  await bot?.emit("message", {
    message: {
      chat: { id: 123 },
      from: { id: 456, username: "alice", first_name: "Alice" },
      text: "Hello from Telegram",
      date: 1_736_380_800,
      message_id: 77,
    },
  });

  expect(onMessage).toHaveBeenCalledWith({
    channel: "telegram",
    accountId: "telegram-test-account",
    chatId: "123",
    senderId: "456",
    senderName: "alice",
    text: "Hello from Telegram",
    isMention: false,
    timestamp: 1_736_380_800_000,
    messageId: "77",
    chatType: "direct",
    attachments: undefined,
    raw: expect.objectContaining({ message_id: 77 }),
  });
});

test("telegram adapter preserves private topic metadata on inbound messages", async () => {
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
  await bot?.emit("message", {
    message: {
      chat: { id: 123, type: "private" },
      message_thread_id: 175380,
      is_topic_message: true,
      from: { id: 456, username: "alice", first_name: "Alice" },
      text: "Hello from private topic",
      date: 1_736_380_800,
      message_id: 77,
    },
  });

  expect(onMessage).toHaveBeenCalledWith({
    channel: "telegram",
    accountId: "telegram-test-account",
    chatId: "123",
    senderId: "456",
    senderName: "alice",
    text: "Hello from private topic",
    isMention: false,
    timestamp: 1_736_380_800_000,
    messageId: "77",
    threadId: "175380",
    chatType: "direct",
    attachments: undefined,
    raw: expect.objectContaining({
      message_id: 77,
      message_thread_id: 175380,
      is_topic_message: true,
    }),
  });
});

test("telegram adapter preserves group topic metadata on inbound messages", async () => {
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
  await bot?.emit("message", {
    message: {
      chat: { id: -100123, type: "supergroup", title: "Void Cafe" },
      message_thread_id: 42,
      from: { id: 456, username: "alice", first_name: "Alice" },
      text: "Hello from topic",
      date: 1_736_380_800,
      message_id: 77,
    },
  });

  expect(onMessage).toHaveBeenCalledWith({
    channel: "telegram",
    accountId: "telegram-test-account",
    chatId: "-100123",
    senderId: "456",
    senderName: "alice",
    chatLabel: "Void Cafe",
    text: "Hello from topic",
    isMention: false,
    timestamp: 1_736_380_800_000,
    messageId: "77",
    threadId: "42",
    chatType: "channel",
    attachments: undefined,
    raw: expect.objectContaining({ message_id: 77 }),
  });
});

test("telegram adapter detects bot mentions and strips a leading mention", async () => {
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
  await bot?.emit("message", {
    message: {
      chat: { id: -100123, type: "supergroup", title: "Void Cafe" },
      from: { id: 456, username: "alice", first_name: "Alice" },
      text: "@test_bot: hello from topic",
      entities: [{ type: "mention", offset: 0, length: 9 }],
      date: 1_736_380_800,
      message_id: 77,
    },
  });

  expect(onMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      chatId: "-100123",
      chatType: "channel",
      isMention: true,
      text: "hello from topic",
    }),
  );
});

test("telegram adapter forwards reply context for quoted messages", async () => {
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
  await bot?.emit("message", {
    message: {
      chat: { id: -100123, type: "supergroup", title: "Void Cafe" },
      from: { id: 456, username: "alice", first_name: "Alice" },
      text: "@test_bot please respond",
      entities: [{ type: "mention", offset: 0, length: 9 }],
      date: 1_736_380_800,
      message_id: 78,
      reply_to_message: {
        chat: { id: -100123, type: "supergroup", title: "Void Cafe" },
        from: { id: 789, username: "blink", first_name: "Blink" },
        text: "Am I allowed as this user to mutate your configuration?",
        date: 1_736_380_790,
        message_id: 77,
      },
    },
  });

  expect(onMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      text: "please respond",
      isMention: true,
      replyContext: {
        messageId: "77",
        senderId: "789",
        senderName: "blink",
        text: "Am I allowed as this user to mutate your configuration?",
      },
    }),
  );
});

test("detectTelegramBotMention preserves non-leading mentions", () => {
  expect(
    detectTelegramBotMention(
      {
        chat: { id: 1, type: "supergroup" },
        from: { id: 2 },
        text: "hey @test_bot can you see this",
        entities: [{ type: "mention", offset: 4, length: 9 }],
        date: 1,
        message_id: 1,
      },
      "test_bot",
    ),
  ).toEqual({
    isMention: true,
    text: "hey @test_bot can you see this",
  });
});

test("detectTelegramBotMention accepts leading bot display name", () => {
  expect(
    detectTelegramBotMention(
      {
        chat: { id: 1, type: "supergroup" },
        from: { id: 2 },
        text: "Void, what am I quoting?",
        date: 1,
        message_id: 1,
      },
      "void_comind_bot",
      "Void",
    ),
  ).toEqual({
    isMention: true,
    text: "what am I quoting?",
  });
});

test("telegram adapter debounces group bursts by chat/topic", async () => {
  const adapter = createTelegramAdapter({
    ...telegramAccountDefaults,
    channel: "telegram",
    enabled: true,
    token: "test-token",
    dmPolicy: "pairing",
    allowedUsers: [],
    inboundDebounceMs: 20,
  });

  const received: InboundChannelMessage[] = [];
  const onMessage = mock(async (message: InboundChannelMessage) => {
    received.push(message);
  });
  adapter.onMessage = onMessage;

  await adapter.start();

  const bot = FakeBot.instances[0];
  await bot?.emit("message", {
    message: {
      chat: { id: -100123, type: "supergroup", title: "Void Cafe" },
      message_thread_id: 42,
      from: { id: 456, username: "alice", first_name: "Alice" },
      text: "first",
      date: 1_736_380_800,
      message_id: 77,
    },
  });
  await bot?.emit("message", {
    message: {
      chat: { id: -100123, type: "supergroup", title: "Void Cafe" },
      message_thread_id: 42,
      from: { id: 789, username: "bob", first_name: "Bob" },
      text: "second",
      date: 1_736_380_801,
      message_id: 78,
    },
  });

  await withTimeout(
    new Promise<void>((resolve) => {
      const check = () => {
        if (received.length === 1) resolve();
        else setTimeout(check, 5);
      };
      check();
    }),
    500,
    "Timed out waiting for Telegram debounce flush",
  );

  expect(onMessage).toHaveBeenCalledTimes(1);
  expect(received[0]).toMatchObject({
    chatId: "-100123",
    threadId: "42",
    chatType: "channel",
    senderId: "789",
    messageId: "78",
    text: "alice: first\nbob: second",
  });
});

test("telegram adapter does not debounce direct messages", async () => {
  const adapter = createTelegramAdapter({
    ...telegramAccountDefaults,
    channel: "telegram",
    enabled: true,
    token: "test-token",
    dmPolicy: "pairing",
    allowedUsers: [],
    inboundDebounceMs: 100,
  });

  const onMessage = mock(async () => {});
  adapter.onMessage = onMessage;

  await adapter.start();

  const bot = FakeBot.instances[0];
  await bot?.emit("message", {
    message: {
      chat: { id: 123, type: "private" },
      from: { id: 456, username: "alice", first_name: "Alice" },
      text: "dm one",
      date: 1_736_380_800,
      message_id: 77,
    },
  });
  await bot?.emit("message", {
    message: {
      chat: { id: 123, type: "private" },
      from: { id: 456, username: "alice", first_name: "Alice" },
      text: "dm two",
      date: 1_736_380_801,
      message_id: 78,
    },
  });

  expect(onMessage).toHaveBeenCalledTimes(2);
});

test("telegram adapter transcribes inbound voice memos when opt-in is enabled", async () => {
  process.env.OPENAI_API_KEY = "sk-test";

  globalThis.fetch = mock(async (url: string | URL | Request) => {
    const href = typeof url === "string" ? url : url.toString();

    if (href.includes("/file/bottest-token/voice/voice1.ogg")) {
      return new Response(Buffer.from("voice-bytes"), {
        status: 200,
        headers: { "content-type": "audio/ogg" },
      });
    }

    if (href === "https://api.openai.com/v1/audio/transcriptions") {
      return new Response(JSON.stringify({ text: "Transcribed voice memo" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    throw new Error(`Unexpected fetch URL: ${href}`);
  }) as unknown as typeof fetch;

  FakeBot.nextGetFileImpl = async () => ({
    file_path: "voice/voice1.ogg",
  });

  const adapter = createTelegramAdapter({
    ...telegramAccountDefaults,
    channel: "telegram",
    enabled: true,
    token: "test-token",
    dmPolicy: "pairing",
    allowedUsers: [],
    transcribeVoice: true,
  });

  const onMessage = mock(async () => {});
  adapter.onMessage = onMessage;

  await adapter.start();

  const bot = FakeBot.instances[0];
  await bot?.emit("message", {
    message: {
      chat: { id: 123 },
      from: { id: 456, username: "alice", first_name: "Alice" },
      text: "",
      date: 1_736_380_800,
      message_id: 77,
      voice: {
        file_id: "voice1",
        file_unique_id: "voice-unique-1",
        mime_type: "audio/ogg",
        file_size: 12,
      },
    },
  });

  expect(onMessage).toHaveBeenCalledTimes(1);
  expect(onMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      attachments: [
        expect.objectContaining({
          kind: "audio",
          mimeType: "audio/ogg",
          transcription: "Transcribed voice memo",
        }),
      ],
    }),
  );
});

test("telegram adapter skips voice transcription unless opt-in is enabled", async () => {
  process.env.OPENAI_API_KEY = "sk-test";

  globalThis.fetch = mock(async (url: string | URL | Request) => {
    const href = typeof url === "string" ? url : url.toString();

    if (href.includes("/file/bottest-token/voice/voice1.ogg")) {
      return new Response(Buffer.from("voice-bytes"), {
        status: 200,
        headers: { "content-type": "audio/ogg" },
      });
    }

    if (href === "https://api.openai.com/v1/audio/transcriptions") {
      throw new Error(
        "Whisper should not be called when transcription is disabled",
      );
    }

    throw new Error(`Unexpected fetch URL: ${href}`);
  }) as unknown as typeof fetch;

  FakeBot.nextGetFileImpl = async () => ({
    file_path: "voice/voice1.ogg",
  });

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
  await bot?.emit("message", {
    message: {
      chat: { id: 123 },
      from: { id: 456, username: "alice", first_name: "Alice" },
      text: "",
      date: 1_736_380_800,
      message_id: 77,
      voice: {
        file_id: "voice1",
        file_unique_id: "voice-unique-1",
        mime_type: "audio/ogg",
        file_size: 12,
      },
    },
  });

  expect(onMessage).toHaveBeenCalledTimes(1);
  expect(onMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      attachments: [
        expect.not.objectContaining({
          transcription: expect.any(String),
        }),
      ],
    }),
  );
});

test("telegram adapter exposes inbound voice transcription errors", async () => {
  process.env.OPENAI_API_KEY = "sk-test";
  const warn = console.warn;
  console.warn = mock(() => {}) as unknown as typeof console.warn;

  globalThis.fetch = mock(async (url: string | URL | Request) => {
    const href = typeof url === "string" ? url : url.toString();

    if (href.includes("/file/bottest-token/voice/voice1.ogg")) {
      return new Response(Buffer.from("voice-bytes"), {
        status: 200,
        headers: { "content-type": "audio/ogg" },
      });
    }

    if (href === "https://api.openai.com/v1/audio/transcriptions") {
      return new Response("Rate limited", { status: 429 });
    }

    throw new Error(`Unexpected fetch URL: ${href}`);
  }) as unknown as typeof fetch;

  FakeBot.nextGetFileImpl = async () => ({
    file_path: "voice/voice1.ogg",
  });

  const adapter = createTelegramAdapter({
    ...telegramAccountDefaults,
    channel: "telegram",
    enabled: true,
    token: "test-token",
    dmPolicy: "pairing",
    allowedUsers: [],
    transcribeVoice: true,
  });

  const onMessage = mock(async () => {});
  adapter.onMessage = onMessage;

  try {
    await adapter.start();

    const bot = FakeBot.instances[0];
    await bot?.emit("message", {
      message: {
        chat: { id: 123 },
        from: { id: 456, username: "alice", first_name: "Alice" },
        text: "",
        date: 1_736_380_800,
        message_id: 77,
        voice: {
          file_id: "voice1",
          file_unique_id: "voice-unique-1",
          mime_type: "audio/ogg",
          file_size: 12,
        },
      },
    });
  } finally {
    console.warn = warn;
  }

  expect(onMessage).toHaveBeenCalledTimes(1);
  expect(onMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      attachments: [
        expect.objectContaining({
          transcriptionError: expect.stringContaining("429"),
        }),
      ],
    }),
  );
});

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

test("telegram lifecycle errors preserve private topic thread ids", async () => {
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
    expect.objectContaining({
      message_thread_id: 42,
      reply_parameters: { message_id: 42 },
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
    "View agent: \x1b]8;;https://app.letta.com/chat/agent-1?conversation=conv-1\x1b\\agent-1\x1b]8;;\x1b\\ (run: run-123)",
  ].join("\n");

  await adapter.start();
  await adapter.handleTurnLifecycleEvent?.({
    type: "finished",
    batchId: "batch-1",
    outcome: "error",
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
    "View agent: \x1b]8;;https://app.letta.com/chat/agent-1?conversation=conv-1\x1b\\agent-1\x1b]8;;\x1b\\ (run: run-456)",
  ].join("\n");

  await adapter.start();
  await adapter.handleTurnLifecycleEvent?.({
    type: "finished",
    batchId: "batch-1",
    outcome: "error",
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

test("telegram adapter batches media groups and downloads inbound images", async () => {
  globalThis.fetch = mock(async (url: string | URL | Request) => {
    const href = typeof url === "string" ? url : url.toString();
    const fileName = href.endsWith("photo2.jpg") ? "second" : "first";
    const content = Buffer.from(`image-${fileName}`);
    return new Response(content, {
      status: 200,
      headers: { "content-type": "image/jpeg" },
    });
  }) as unknown as typeof fetch;

  FakeBot.nextGetFileImpl = async (fileId) => ({
    file_path: fileId === "photo2" ? "photos/photo2.jpg" : "photos/photo1.jpg",
  });

  const adapter = createTelegramAdapter({
    ...telegramAccountDefaults,
    channel: "telegram",
    enabled: true,
    token: "test-token",
    dmPolicy: "pairing",
    allowedUsers: [],
  });

  let resolveInboundMessage:
    | ((message: InboundChannelMessage) => void)
    | undefined;
  const inboundMessage = new Promise<InboundChannelMessage>((resolve) => {
    resolveInboundMessage = resolve;
  });
  const onMessage = mock(async (message: InboundChannelMessage) => {
    resolveInboundMessage?.(message);
  });
  adapter.onMessage = onMessage;

  await adapter.start();

  const bot = FakeBot.instances[0];
  try {
    await bot?.emit("message", {
      message: {
        chat: { id: 123 },
        from: { id: 456, username: "alice", first_name: "Alice" },
        caption: "Vacation photos",
        date: 1_736_380_800,
        message_id: 10,
        media_group_id: "album-1",
        photo: [
          { file_id: "photo1", file_unique_id: "unique-1", file_size: 12 },
        ],
      },
    });
    await bot?.emit("message", {
      message: {
        chat: { id: 123 },
        from: { id: 456, username: "alice", first_name: "Alice" },
        date: 1_736_380_801,
        message_id: 11,
        media_group_id: "album-1",
        photo: [
          { file_id: "photo2", file_unique_id: "unique-2", file_size: 13 },
        ],
      },
    });

    const inbound = await withTimeout(
      inboundMessage,
      2_000,
      "Timed out waiting for Telegram media group flush",
    );

    expect(onMessage).toHaveBeenCalledTimes(1);

    expect(inbound.text).toBe("Vacation photos");
    expect(inbound.attachments).toHaveLength(2);
    expect(
      inbound.attachments?.every((attachment) => attachment.kind === "image"),
    ).toBe(true);

    const localPaths = inbound.attachments
      ?.map((attachment) => attachment.localPath)
      .filter((value): value is string => typeof value === "string");
    expect(localPaths).toHaveLength(2);

    for (const localPath of localPaths ?? []) {
      expect(existsSync(localPath)).toBe(true);
      expect(readFileSync(localPath, "utf-8").startsWith("image-")).toBe(true);
    }
  } finally {
    rmSync(channelRoot, { recursive: true, force: true });
    channelRoot = mkdtempSync(join(tmpdir(), "letta-telegram-root-"));
  }
});

test("telegram adapter preserves photo mime type when Telegram download responds with octet-stream", async () => {
  globalThis.fetch = mock(
    async () =>
      new Response(Buffer.from("fake-jpeg"), {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      }),
  ) as unknown as typeof fetch;

  FakeBot.nextGetFileImpl = async () => ({
    file_path: "photos/photo.jpg",
  });

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
  try {
    await bot?.emit("message", {
      message: {
        chat: { id: 123 },
        from: { id: 456, username: "alice", first_name: "Alice" },
        date: 1_736_380_800,
        message_id: 10,
        photo: [
          { file_id: "photo1", file_unique_id: "unique-1", file_size: 9 },
        ],
      },
    });

    expect(onMessage).toHaveBeenCalledTimes(1);
    const firstCall = onMessage.mock.calls[0] as unknown as
      | [InboundChannelMessage]
      | undefined;
    expect(firstCall).toBeDefined();
    if (!firstCall) {
      throw new Error("Expected inbound Telegram photo to emit a message");
    }

    const [inbound] = firstCall;
    expect(inbound.attachments).toHaveLength(1);
    expect(inbound.attachments?.[0]).toMatchObject({
      kind: "image",
      mimeType: "image/jpeg",
      imageDataBase64: Buffer.from("fake-jpeg").toString("base64"),
    });
  } finally {
    rmSync(channelRoot, { recursive: true, force: true });
    channelRoot = mkdtempSync(join(tmpdir(), "letta-telegram-root-"));
  }
});

test("telegram adapter does not inline SVG documents as model images", async () => {
  const svgBytes = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#ff6600" /></svg>',
  );
  globalThis.fetch = mock(
    async () =>
      new Response(svgBytes, {
        status: 200,
        headers: { "content-type": "image/svg+xml" },
      }),
  ) as unknown as typeof fetch;

  FakeBot.nextGetFileImpl = async () => ({
    file_path: "documents/void-final.svg",
  });

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
  try {
    await bot?.emit("message", {
      message: {
        chat: { id: 123 },
        from: { id: 456, username: "alice", first_name: "Alice" },
        caption: "Extract the colors",
        date: 1_736_380_800,
        message_id: 10,
        document: {
          file_id: "svg1",
          file_name: "void-final.svg",
          mime_type: "image/svg+xml",
          file_size: svgBytes.byteLength,
        },
      },
    });

    expect(onMessage).toHaveBeenCalledTimes(1);
    const firstCall = onMessage.mock.calls[0] as unknown as
      | [InboundChannelMessage]
      | undefined;
    expect(firstCall).toBeDefined();
    if (!firstCall) {
      throw new Error("Expected inbound Telegram SVG to emit a message");
    }

    const [inbound] = firstCall;
    expect(inbound.attachments).toHaveLength(1);
    const attachment = inbound.attachments?.[0];
    expect(attachment).toMatchObject({
      kind: "image",
      name: "void-final.svg",
      mimeType: "image/svg+xml",
      sizeBytes: svgBytes.byteLength,
    });
    expect(attachment?.imageDataBase64).toBeUndefined();
    expect(attachment?.localPath).toBeDefined();
    if (!attachment?.localPath) {
      throw new Error("Expected inbound Telegram SVG to be saved locally");
    }
    expect(readFileSync(attachment.localPath)).toEqual(svgBytes);
  } finally {
    rmSync(channelRoot, { recursive: true, force: true });
    channelRoot = mkdtempSync(join(tmpdir(), "letta-telegram-root-"));
  }
});

test("telegram adapter downloads inbound wav documents as audio", async () => {
  const wavBytes = Buffer.from("wav-bytes");
  globalThis.fetch = mock(
    async () =>
      new Response(wavBytes, {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      }),
  ) as unknown as typeof fetch;

  FakeBot.nextGetFileImpl = async () => ({
    file_path: "documents/clip",
  });

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
  try {
    await bot?.emit("message", {
      message: {
        chat: { id: 123 },
        from: { id: 456, username: "alice", first_name: "Alice" },
        date: 1_736_380_800,
        message_id: 10,
        document: {
          file_id: "wav1",
          file_name: "clip.wav",
          file_size: wavBytes.byteLength,
        },
      },
    });

    expect(onMessage).toHaveBeenCalledTimes(1);
    const firstCall = onMessage.mock.calls[0] as unknown as
      | [InboundChannelMessage]
      | undefined;
    expect(firstCall).toBeDefined();
    if (!firstCall) {
      throw new Error("Expected inbound Telegram WAV to emit a message");
    }

    const [inbound] = firstCall;
    expect(inbound.attachments).toHaveLength(1);
    const attachment = inbound.attachments?.[0];
    expect(attachment).toMatchObject({
      kind: "audio",
      name: "clip.wav",
      mimeType: "audio/wav",
      sizeBytes: wavBytes.byteLength,
    });
    expect(attachment?.localPath).toBeDefined();
    if (!attachment?.localPath) {
      throw new Error("Expected inbound Telegram WAV to be saved locally");
    }
    expect(readFileSync(attachment.localPath)).toEqual(wavBytes);
  } finally {
    rmSync(channelRoot, { recursive: true, force: true });
    channelRoot = mkdtempSync(join(tmpdir(), "letta-telegram-root-"));
  }
});

test("telegram adapter logs when oversized inbound attachments are skipped", async () => {
  globalThis.fetch = mock(async () => {
    throw new Error("oversized attachment should not be downloaded");
  }) as unknown as typeof fetch;

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
  const oversizedBytes = MAX_TELEGRAM_DOWNLOAD_BYTES + 1;
  await bot?.emit("message", {
    message: {
      chat: { id: 123 },
      from: { id: 456, username: "alice", first_name: "Alice" },
      text: "Oversized attachment",
      date: 1_736_380_800,
      message_id: 10,
      document: {
        file_id: "too-big",
        file_name: "too-big.wav",
        file_size: oversizedBytes,
      },
    },
  });

  expect(onMessage).toHaveBeenCalledWith(
    expect.objectContaining({ attachments: undefined }),
  );
  expect(bot?.api.getFile).not.toHaveBeenCalled();
  expect(consoleWarnSpy).toHaveBeenCalledWith(
    `[Telegram] Skipping attachment too-big.wav: ${oversizedBytes} bytes exceeds Telegram download limit (${MAX_TELEGRAM_DOWNLOAD_BYTES} bytes).`,
  );
});

test("telegram adapter logs attachment download failures", async () => {
  globalThis.fetch = mock(async () => {
    throw new Error("network down");
  }) as unknown as typeof fetch;

  FakeBot.nextGetFileImpl = async () => ({
    file_path: "documents/fail.wav",
  });

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
  await bot?.emit("message", {
    message: {
      chat: { id: 123 },
      from: { id: 456, username: "alice", first_name: "Alice" },
      text: "Download this",
      date: 1_736_380_800,
      message_id: 10,
      document: {
        file_id: "fail",
        file_name: "fail.wav",
        file_size: 9,
      },
    },
  });

  expect(onMessage).toHaveBeenCalledWith(
    expect.objectContaining({ attachments: undefined }),
  );
  expect(consoleWarnSpy).toHaveBeenCalledWith(
    "[Telegram] Attachment download failed for fail.wav: network down",
  );
});

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

test("telegram control prompts preserve private topic thread ids", async () => {
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
