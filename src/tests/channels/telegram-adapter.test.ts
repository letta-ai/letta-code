import { afterEach, beforeEach, expect, mock, test } from "bun:test";

type FakeBotStartOptions = {
  onStart?: (botInfo: {
    username?: string;
    id: number;
  }) => void | Promise<void>;
};

class FakeBot {
  static instances: FakeBot[] = [];
  static nextStartImpl: () => Promise<void> = async () => {};

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
    void options?.onStart?.(this.botInfo);
    return FakeBot.nextStartImpl();
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
  FakeBot.nextStartImpl = async () => {};
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

test("telegram adapter logs and clears running state when polling exits unexpectedly", async () => {
  FakeBot.nextStartImpl = async () => {
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
