import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  __testOverrideLoadChannelAccounts,
  __testOverrideSaveChannelAccounts,
  clearChannelAccountStores,
} from "@/channels/accounts";
import {
  __testOverrideLoadPairingStore,
  __testOverrideSavePairingStore,
  clearPairingStores,
} from "@/channels/pairing";
import {
  __testOverrideLoadPendingControlRequestStore,
  __testOverrideSavePendingControlRequestStore,
  clearPendingControlRequestStore,
} from "@/channels/pending-control-requests";
import { __testOverrideLoadChannelPlugin } from "@/channels/plugin-registry";
import {
  ChannelInitializationError,
  ChannelRegistry,
  getChannelRegistry,
  initializeChannels,
} from "@/channels/registry";
import {
  __testOverrideLoadRoutes,
  __testOverrideSaveRoutes,
  addRoute,
  clearAllRoutes,
} from "@/channels/routing";
import { buildMissingChannelRuntimeError } from "@/channels/runtime-deps";
import type {
  ChannelAdapter,
  SignalChannelAccount,
  TelegramChannelAccount,
} from "@/channels/types";

beforeEach(() => {
  __testOverrideLoadPendingControlRequestStore(null);
  __testOverrideSavePendingControlRequestStore(null);
  clearPendingControlRequestStore();
});

afterEach(() => {
  __testOverrideLoadPendingControlRequestStore(null);
  __testOverrideSavePendingControlRequestStore(null);
  clearPendingControlRequestStore();
});

describe("ChannelRegistry lifecycle", () => {
  beforeEach(() => {
    __testOverrideLoadRoutes(() => null);
    __testOverrideSaveRoutes(() => {});
    __testOverrideLoadPairingStore(() => null);
    __testOverrideSavePairingStore(() => {});
  });

  afterEach(async () => {
    const registry = getChannelRegistry();
    if (registry) {
      await registry.stopAll();
    }
    clearAllRoutes();
    clearPairingStores();
    clearChannelAccountStores();
    __testOverrideLoadRoutes(null);
    __testOverrideSaveRoutes(null);
    __testOverrideLoadPairingStore(null);
    __testOverrideSavePairingStore(null);
    __testOverrideLoadChannelAccounts(null);
    __testOverrideSaveChannelAccounts(null);
  });

  test("pause() stops delivery but keeps singleton alive", () => {
    const registry = new ChannelRegistry();
    registry.setMessageHandler(() => {});
    registry.setReady();

    expect(registry.isReady()).toBe(true);
    expect(getChannelRegistry()).toBe(registry);

    registry.pause();
    expect(registry.isReady()).toBe(false);
    // Singleton survives pause (unlike stopAll)
    expect(getChannelRegistry()).toBe(registry);

    // Re-register and setReady (simulates WS reconnect)
    registry.setMessageHandler(() => {});
    registry.setReady();
    expect(registry.isReady()).toBe(true);
  });

  test("stopAll() destroys the singleton", async () => {
    const registry = new ChannelRegistry();
    expect(getChannelRegistry()).toBe(registry);

    await registry.stopAll();
    expect(getChannelRegistry()).toBeNull();
  });

  test("route-derived recovery sources do not invent an originating message", () => {
    const registry = new ChannelRegistry();
    registry.registerAdapter({
      id: "slack:acct-slack",
      channelId: "slack",
      accountId: "acct-slack",
      name: "Slack",
      start: async () => {},
      stop: async () => {},
      isRunning: () => true,
      sendMessage: async () => ({ messageId: "msg-1" }),
      sendDirectReply: async () => {},
    });
    addRoute("slack", {
      accountId: "acct-slack",
      chatId: "C123",
      chatType: "channel",
      threadId: "1712790000.000050",
      agentId: "agent-1",
      conversationId: "conv-1",
      enabled: true,
      createdAt: "2026-07-09T00:00:00.000Z",
    });

    expect(registry.resolveTurnSourcesForScope("agent-1", "conv-1")).toEqual([
      {
        channel: "slack",
        accountId: "acct-slack",
        chatId: "C123",
        chatType: "channel",
        threadId: "1712790000.000050",
        agentId: "agent-1",
        conversationId: "conv-1",
      },
    ]);
  });

  test("route-derived sources require a running adapter and outbound route", () => {
    let running = false;
    const registry = new ChannelRegistry();
    registry.registerAdapter({
      id: "slack:acct-slack",
      channelId: "slack",
      accountId: "acct-slack",
      name: "Slack",
      start: async () => {},
      stop: async () => {},
      isRunning: () => running,
      sendMessage: async () => ({ messageId: "msg-1" }),
      sendDirectReply: async () => {},
    });
    const route = {
      accountId: "acct-slack",
      chatId: "C123",
      chatType: "channel" as const,
      threadId: null,
      agentId: "agent-1",
      conversationId: "conv-1",
      enabled: true,
      outboundEnabled: true,
      createdAt: "2026-08-05T00:00:00.000Z",
    };
    addRoute("slack", route);

    expect(registry.resolveTurnSourcesForScope("agent-1", "conv-1")).toEqual(
      [],
    );

    running = true;
    expect(
      registry.resolveTurnSourcesForScope("agent-1", "conv-1"),
    ).toHaveLength(1);

    addRoute("slack", { ...route, outboundEnabled: false });
    expect(registry.resolveTurnSourcesForScope("agent-1", "conv-1")).toEqual(
      [],
    );
  });

  test("initializeChannels throws when requested channel startup fails", async () => {
    __testOverrideLoadChannelAccounts(() => []);
    const logs: string[] = [];

    await expect(
      initializeChannels(["telegram"], {
        failOnStartupError: true,
        logger: (message) => logs.push(message),
      }),
    ).rejects.toBeInstanceOf(ChannelInitializationError);

    expect(logs).toContain("[Channels] requested: telegram");
    expect(logs.some((line) => line.includes("root:"))).toBe(true);
    expect(logs.some((line) => line.includes("accounts=0"))).toBe(true);
  });

  test("startChannelAccount rejects Signal accounts sharing one daemon", async () => {
    const now = "2026-06-17T00:00:00.000Z";
    const makeSignalAccount = (
      accountId: string,
      account: string,
    ): SignalChannelAccount => ({
      channel: "signal",
      accountId,
      displayName: accountId,
      enabled: true,
      dmPolicy: "pairing",
      allowedUsers: [],
      createdAt: now,
      updatedAt: now,
      baseUrl: "http://127.0.0.1:8080/",
      account,
      agentId: null,
      selfChatMode: false,
      groupMode: "disabled",
      allowedGroups: [],
      mentionPatterns: [],
      recipientAliases: {},
      downloadMedia: true,
    });
    __testOverrideLoadChannelAccounts(() => [
      makeSignalAccount("one", "+15555550100"),
      makeSignalAccount("two", "+15555550101"),
    ]);
    const registry = new ChannelRegistry();

    await expect(registry.startChannelAccount("signal", "one")).rejects.toThrow(
      /share base_url/,
    );
  });

  test("initializeChannels does not start accounts outside the restore scope", async () => {
    __testOverrideLoadChannelAccounts(() => [
      {
        channel: "slack",
        accountId: "acct-cloud-slack",
        enabled: true,
        mode: "socket",
        botToken: "xoxb-test-token",
        appToken: "xapp-test-token",
        agentId: "agent-cloud",
        defaultPermissionMode: "unrestricted",
        dmPolicy: "pairing",
        allowedUsers: [],
        createdAt: "2026-06-17T00:00:00.000Z",
        updatedAt: "2026-06-17T00:00:00.000Z",
      },
    ]);
    __testOverrideSaveChannelAccounts(() => {});
    const logs: string[] = [];

    await expect(
      initializeChannels(["slack"], {
        restoreAgentScope: "local",
        logger: (message) => logs.push(message),
      }),
    ).resolves.toBeInstanceOf(ChannelRegistry);

    expect(logs).toContain(
      '[Channels] Channel "slack" has no enabled accounts in local restore scope.',
    );
  });
});

describe("ChannelRegistry startup isolation", () => {
  const createdAt = "2026-08-10T00:00:00.000Z";

  beforeEach(() => {
    __testOverrideLoadRoutes(() => null);
    __testOverrideSaveRoutes(() => {});
    __testOverrideLoadPairingStore(() => null);
    __testOverrideSavePairingStore(() => {});
  });

  afterEach(async () => {
    const registry = getChannelRegistry();
    if (registry) {
      await registry.stopAll();
    }
    clearAllRoutes();
    clearPairingStores();
    clearChannelAccountStores();
    __testOverrideLoadRoutes(null);
    __testOverrideSaveRoutes(null);
    __testOverrideLoadPairingStore(null);
    __testOverrideSavePairingStore(null);
    __testOverrideLoadChannelAccounts(null);
    __testOverrideSaveChannelAccounts(null);
    __testOverrideLoadChannelPlugin(null);
  });

  function makeTelegramAccount(accountId: string): TelegramChannelAccount {
    return {
      channel: "telegram",
      accountId,
      enabled: true,
      token: `token-${accountId}`,
      binding: { agentId: null, conversationId: null },
      dmPolicy: "pairing",
      allowedUsers: [],
      createdAt,
      updatedAt: createdAt,
    };
  }

  function makeAdapter(
    account: TelegramChannelAccount,
    startFailure?: () => Error,
  ): ChannelAdapter {
    let running = false;
    return {
      id: `telegram:${account.accountId}`,
      channelId: "telegram",
      accountId: account.accountId,
      name: "Telegram",
      async start(): Promise<void> {
        const failure = startFailure?.();
        if (failure) throw failure;
        running = true;
      },
      async stop(): Promise<void> {
        running = false;
      },
      isRunning: () => running,
      async sendMessage() {
        return { messageId: "msg-1" };
      },
      async sendDirectReply(): Promise<void> {},
    };
  }

  function overridePlugin(
    startFailureFor: (accountId: string) => Error | undefined,
  ): void {
    __testOverrideLoadChannelPlugin(async () => ({
      metadata: {
        id: "telegram",
        displayName: "Telegram",
        runtimePackages: [],
        runtimeModules: [],
      },
      createAdapter: (account) => {
        const telegramAccount = account as TelegramChannelAccount;
        const failure = startFailureFor(telegramAccount.accountId);
        return makeAdapter(
          telegramAccount,
          failure ? () => failure : undefined,
        );
      },
    }));
  }

  test("keeps healthy accounts running when one account fails to start", async () => {
    __testOverrideLoadChannelAccounts(() => [
      makeTelegramAccount("good"),
      makeTelegramAccount("bad"),
    ]);
    __testOverrideSaveChannelAccounts(() => {});
    overridePlugin((accountId) =>
      accountId === "bad"
        ? new Error("Telegram bot init timed out after 15000ms")
        : undefined,
    );
    const logs: string[] = [];

    const registry = await initializeChannels(["telegram"], {
      failOnStartupError: true,
      logger: (message) => logs.push(message),
    });

    expect(registry.getActiveChannelIds()).toEqual(["telegram"]);
    expect(registry.getAdapter("telegram", "good")?.isRunning()).toBe(true);
    // The half-started adapter is dropped instead of lingering unregistered.
    expect(registry.getAdapter("telegram", "bad")).toBeNull();
    expect(
      logs.some((line) =>
        line.includes("Some channel accounts failed to start"),
      ),
    ).toBe(true);
    expect(
      logs.some((line) =>
        line.includes(
          "telegram/bad: Telegram bot init timed out after 15000ms",
        ),
      ),
    ).toBe(true);
  });

  test("does not suggest installing runtimes for unrelated failures", async () => {
    __testOverrideLoadChannelAccounts(() => [
      makeTelegramAccount("good"),
      makeTelegramAccount("bad"),
    ]);
    __testOverrideSaveChannelAccounts(() => {});
    overridePlugin((accountId) =>
      accountId === "bad"
        ? new Error("Telegram bot init timed out after 15000ms")
        : undefined,
    );
    const logs: string[] = [];

    await initializeChannels(["telegram"], {
      failOnStartupError: true,
      logger: (message) => logs.push(message),
    });

    expect(logs.some((line) => line.includes("Install missing runtimes"))).toBe(
      false,
    );
  });

  test("suggests installing the runtime when it is missing", async () => {
    __testOverrideLoadChannelAccounts(() => [
      makeTelegramAccount("good"),
      makeTelegramAccount("bad"),
    ]);
    __testOverrideSaveChannelAccounts(() => {});
    overridePlugin((accountId) =>
      accountId === "bad"
        ? buildMissingChannelRuntimeError("telegram")
        : undefined,
    );
    const logs: string[] = [];

    await initializeChannels(["telegram"], {
      failOnStartupError: true,
      logger: (message) => logs.push(message),
    });

    expect(
      logs.some((line) =>
        line.includes(
          "Install missing runtimes with: letta server --channels telegram",
        ),
      ),
    ).toBe(true);
  });

  test("fails startup when no account could start", async () => {
    __testOverrideLoadChannelAccounts(() => [makeTelegramAccount("bad")]);
    __testOverrideSaveChannelAccounts(() => {});
    overridePlugin(
      () => new Error("Telegram bot init timed out after 15000ms"),
    );

    await expect(
      initializeChannels(["telegram"], { failOnStartupError: true }),
    ).rejects.toBeInstanceOf(ChannelInitializationError);
  });

  test("keeps the channel failure fatal even when another account started", async () => {
    __testOverrideLoadChannelAccounts((channelId) =>
      channelId === "telegram" ? [makeTelegramAccount("good")] : [],
    );
    __testOverrideSaveChannelAccounts(() => {});
    overridePlugin(() => undefined);

    await expect(
      initializeChannels(["telegram", "discord"], { failOnStartupError: true }),
    ).rejects.toBeInstanceOf(ChannelInitializationError);
  });
});
