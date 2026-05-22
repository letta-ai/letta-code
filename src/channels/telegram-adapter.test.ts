import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { __testOverrideChannelsRoot } from "@/channels/config";
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

  async init(): Promise<void> {}

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

const { __testOverrideSubmitChannelLifecycleErrorReport } = await import(
  "@/channels/lifecycle-error-report"
);
const { createTelegramAdapter } = await import("@/channels/telegram/adapter");

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
const originalConsoleError = console.error;
const originalFetch = globalThis.fetch;
const originalOpenAiApiKey = process.env.OPENAI_API_KEY;

beforeEach(() => {
  channelRoot = mkdtempSync(join(tmpdir(), "letta-telegram-root-"));
  __testOverrideChannelsRoot(channelRoot);
  FakeBot.instances.length = 0;
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
  console.error = consoleErrorSpy as typeof console.error;
  globalThis.fetch = originalFetch;
  __testOverrideSubmitChannelLifecycleErrorReport(null);
  delete process.env.OPENAI_API_KEY;
});

afterEach(() => {
  __testOverrideChannelsRoot(null);
  console.error = originalConsoleError;
  globalThis.fetch = originalFetch;
  __testOverrideSubmitChannelLifecycleErrorReport(null);
  if (originalOpenAiApiKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = originalOpenAiApiKey;
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
    chatId: "123",
    text: "<b>see image</b>",
    parseMode: "HTML",
    replyToMessageId: "456",
    mediaPath: "/tmp/screenshot.png",
    fileName: "screenshot.png",
    title: "Screenshot",
  });

  const bot = FakeBot.instances[0];
  expect(bot?.api.sendPhoto).toHaveBeenCalledWith(
    "123",
    expect.any(FakeInputFile),
    {
      caption: "<b>see image</b>",
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
    timestamp: 1_736_380_800_000,
    messageId: "77",
    chatType: "direct",
    attachments: undefined,
    raw: expect.objectContaining({ message_id: 77 }),
  });
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
