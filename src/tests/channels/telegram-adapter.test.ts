import { afterEach, beforeEach, expect, mock, test } from "bun:test";

type FakeBotStartOptions = {
  onStart?: (botInfo: {
    username?: string;
    id: number;
  }) => void | Promise<void>;
};

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

  readonly token: string;
  botInfo = { username: "test_bot", id: 12345 };
  readonly api = {
    sendMessage: mock(async () => ({ message_id: 999 })),
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

  on(): this {
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
}

mock.module("../../channels/telegram/runtime", () => ({
  loadGrammyModule: async () => ({
    Bot: FakeBot,
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
  consoleErrorSpy.mockClear();
  console.error = consoleErrorSpy as typeof console.error;
});

afterEach(() => {
  console.error = originalConsoleError;
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
