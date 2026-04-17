import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { InboundChannelMessage } from "../../channels/types";

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

mock.module("../../channels/config", () => ({
  getChannelDir: (channelId: string) => join(channelRoot, channelId),
}));

mock.module("../../channels/telegram/runtime", () => ({
  loadGrammyModule: async () => ({
    Bot: FakeBot,
    InputFile: FakeInputFile,
  }),
}));

const { createTelegramAdapter } = await import(
  "../../channels/telegram/adapter"
);

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
  delete process.env.OPENAI_API_KEY;
});

afterEach(() => {
  console.error = originalConsoleError;
  globalThis.fetch = originalFetch;
  if (originalOpenAiApiKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = originalOpenAiApiKey;
  }
  rmSync(channelRoot, { recursive: true, force: true });
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

test("telegram adapter auto-transcribes inbound voice memos when OPENAI_API_KEY is set", async () => {
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

  const onMessage = mock(async () => {});
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

    await new Promise((resolve) => setTimeout(resolve, 220));

    expect(onMessage).toHaveBeenCalledTimes(1);
    const firstCall = onMessage.mock.calls[0] as unknown as
      | [InboundChannelMessage]
      | undefined;
    expect(firstCall).toBeDefined();
    if (!firstCall) {
      throw new Error("Expected inbound Telegram album to emit a message");
    }

    const [inbound] = firstCall;

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
