import { afterEach, beforeEach, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __testSetBackend, type Backend } from "@/backend";
import { __testOverrideGetClient } from "@/backend/api/client";
import { clearChannelAccountStores } from "@/channels/accounts";
import { __testOverrideChannelsRoot } from "@/channels/config";
import { __setActiveChannelCredentialsStoreModeForTests } from "@/channels/credential-store";
import { __testOverrideSubmitChannelLifecycleErrorReport } from "@/channels/lifecycle-error-report";
import { clearPairingStores } from "@/channels/pairing";
import { clearPendingControlRequestStore } from "@/channels/pending-control-requests";
import { getChannelRegistry } from "@/channels/registry";
import { clearAllRoutes, getRoute } from "@/channels/routing";
import {
  bindChannelAccountLive,
  createChannelAccountLive,
  getChannelAccountSnapshot,
  setChannelConfigLive,
  startChannelAccountLive,
} from "@/channels/service";
import { clearTargetStores } from "@/channels/targets";
import { createTelegramAdapter } from "@/channels/telegram/adapter";
import { MAX_TELEGRAM_DOWNLOAD_BYTES } from "@/channels/telegram/media";
import { __testOverrideLoadGrammyModule } from "@/channels/telegram/runtime";
import { detectTelegramBotMention } from "@/channels/telegram/utils";

export type FakeBotStartOptions = {
  onStart?: (botInfo: {
    username?: string;
    id: number;
  }) => void | Promise<void>;
  allowed_updates?: string[];
};

export type FakeHandler = (ctx: unknown) => unknown | Promise<unknown>;

export let channelRoot = join(tmpdir(), "letta-telegram-test-root");

export class FakeInputFile {
  readonly file: string;
  readonly filename?: string;

  constructor(file: string, filename?: string) {
    this.file = file;
    this.filename = filename;
  }
}

export class FakeBot {
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

export const createConversation = mock(async () => ({
  id: "conv-telegram-e2e",
}));

export const telegramAccountDefaults = {
  accountId: "telegram-test-account",
  displayName: "@test_bot",
  binding: {
    agentId: null,
    conversationId: null,
  },
  createdAt: "2026-04-11T00:00:00.000Z",
  updatedAt: "2026-04-11T00:00:00.000Z",
} as const;

export const consoleErrorSpy = mock(() => {});

export const consoleWarnSpy = mock(() => {});

const originalConsoleError = console.error;

const originalConsoleWarn = console.warn;

const originalFetch = globalThis.fetch;

const originalOpenAiApiKey = process.env.OPENAI_API_KEY;

const originalTelegramDebounce = process.env.LETTA_TELEGRAM_INBOUND_DEBOUNCE_MS;

export async function withTimeout<T>(
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

export function installTelegramAdapterTestHooks(): void {
  beforeEach(() => {
    __testOverrideLoadGrammyModule(
      async () =>
        ({
          Bot: FakeBot,
          InputFile: FakeInputFile,
        }) as unknown as typeof import("grammy"),
    );
    __testOverrideGetClient(async () => ({
      conversations: { create: createConversation },
    }));
    __testSetBackend({
      createConversation,
    } as unknown as Backend);
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
    __testOverrideLoadGrammyModule(null);
    __testOverrideGetClient(null);
    __testSetBackend(null);
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
}

export function resetTelegramChannelRoot(): void {
  rmSync(channelRoot, { recursive: true, force: true });
  channelRoot = mkdtempSync(join(tmpdir(), "letta-telegram-root-"));
  __testOverrideChannelsRoot(channelRoot);
}

export {
  __testOverrideSubmitChannelLifecycleErrorReport,
  bindChannelAccountLive,
  createChannelAccountLive,
  createTelegramAdapter,
  detectTelegramBotMention,
  getChannelAccountSnapshot,
  getChannelRegistry,
  getRoute,
  MAX_TELEGRAM_DOWNLOAD_BYTES,
  setChannelConfigLive,
  startChannelAccountLive,
};
