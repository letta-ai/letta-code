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
};

type FakeHandler = (ctx: unknown) => unknown | Promise<unknown>;

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

  command(): this {
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

mock.module("grammy", () => ({
  Bot: FakeBot,
}));

const { createTelegramAdapter } = await import(
  "../../channels/telegram/adapter"
);

const consoleErrorSpy = mock(() => {});
const originalConsoleError = console.error;

beforeEach(() => {
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
});

afterEach(() => {
  console.error = originalConsoleError;
});

test("telegram adapter logs unhandled grammY errors with update context", async () => {
  const adapter = createTelegramAdapter({
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
    channel: "telegram",
    enabled: true,
    token: "test-token",
    dmPolicy: "pairing",
    allowedUsers: [],
  });

  const startPromise = adapter.start();
  expect(adapter.isRunning()).toBe(false);

  await Promise.resolve();
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

test("telegram adapter forwards text messages through onMessage", async () => {
  const adapter = createTelegramAdapter({
    channel: "telegram",
    enabled: true,
    token: "test-token",
    dmPolicy: "pairing",
    allowedUsers: [],
  });

  const onMessage = mock(async () => {});
  adapter.onMessage = onMessage;

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
    chatId: "123",
    senderId: "456",
    senderName: "alice",
    text: "Hello from Telegram",
    timestamp: 1_736_380_800_000,
    messageId: "77",
    attachments: undefined,
    raw: expect.objectContaining({ message_id: 77 }),
  });
});

test("telegram adapter batches media groups and downloads inbound images", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "letta-telegram-media-"));
  const adapter = createTelegramAdapter(
    {
      channel: "telegram",
      enabled: true,
      token: "test-token",
      dmPolicy: "pairing",
      allowedUsers: [],
    },
    {
      mediaGroupFlushMs: 1,
      resolveInboundMediaDir: () => tempDir,
      fetchImpl: mock(async (url: string) => {
        const fileName = url.endsWith("photo2.jpg") ? "second" : "first";
        const content = Buffer.from(`image-${fileName}`);
        return new Response(content, {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        });
      }) as unknown as typeof fetch,
    },
  );

  FakeBot.nextGetFileImpl = async (fileId) => ({
    file_path: fileId === "photo2" ? "photos/photo2.jpg" : "photos/photo1.jpg",
  });

  const onMessage = mock(async () => {});
  adapter.onMessage = onMessage;

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

    await new Promise((resolve) => setTimeout(resolve, 20));

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
    rmSync(tempDir, { recursive: true, force: true });
  }
});
