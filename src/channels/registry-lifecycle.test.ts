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
import {
  ChannelInitializationError,
  ChannelRegistry,
  formatChannelStartupFailures,
  getChannelRegistry,
  initializeChannels,
} from "@/channels/registry";
import {
  __testOverrideLoadRoutes,
  __testOverrideSaveRoutes,
  addRoute,
  clearAllRoutes,
} from "@/channels/routing";
import type {
  ChannelAccount,
  ChannelAdapter,
  SignalChannelAccount,
} from "@/channels/types";

const ACCOUNT_TIMESTAMP = "2026-06-17T00:00:00.000Z";

function makeTelegramAccount(accountId: string): ChannelAccount {
  return {
    channel: "telegram",
    accountId,
    enabled: true,
    token: `token-${accountId}`,
    binding: { agentId: null, conversationId: null },
    dmPolicy: "pairing",
    allowedUsers: [],
    createdAt: ACCOUNT_TIMESTAMP,
    updatedAt: ACCOUNT_TIMESTAMP,
  };
}

function makeSlackAccount(accountId: string): ChannelAccount {
  return {
    channel: "slack",
    accountId,
    enabled: true,
    mode: "socket",
    botToken: "xoxb-test-token",
    appToken: "xapp-test-token",
    agentId: null,
    defaultPermissionMode: "unrestricted",
    dmPolicy: "pairing",
    allowedUsers: [],
    createdAt: ACCOUNT_TIMESTAMP,
    updatedAt: ACCOUNT_TIMESTAMP,
  };
}

function makeRunningAdapter(
  channelId: string,
  accountId: string,
): ChannelAdapter & { stopped: () => boolean } {
  let running = true;
  return {
    id: `${channelId}:${accountId}`,
    channelId,
    accountId,
    name: channelId,
    start: async () => {},
    stop: async () => {
      running = false;
    },
    isRunning: () => running,
    sendMessage: async () => ({ messageId: "msg-1" }),
    sendDirectReply: async () => {},
    stopped: () => !running,
  };
}

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

  test("one failed account does not stop accounts that started", async () => {
    __testOverrideLoadChannelAccounts((channelId) =>
      channelId === "telegram"
        ? [
            makeTelegramAccount("bot-a"),
            makeTelegramAccount("bot-slow"),
            makeTelegramAccount("bot-b"),
          ]
        : channelId === "slack"
          ? [makeSlackAccount("workspace")]
          : [],
    );
    __testOverrideSaveChannelAccounts(() => {});
    const registry = new ChannelRegistry();
    const adapters: ReturnType<typeof makeRunningAdapter>[] = [];
    let slowAttempts = 0;
    registry.startChannelAccount = async (channelId, accountId) => {
      if (accountId === "bot-slow") {
        slowAttempts += 1;
        if (slowAttempts === 1) {
          throw new Error("Telegram bot init timed out after 15000ms");
        }
      }
      const adapter = makeRunningAdapter(channelId, accountId);
      adapters.push(adapter);
      registry.registerAdapter(adapter);
      return true;
    };
    const logs: string[] = [];

    await expect(
      initializeChannels(["telegram", "slack"], {
        failOnStartupError: true,
        logger: (message) => logs.push(message),
        startupRetryPolicy: { initialDelayMs: 1, maxDelayMs: 1 },
      }),
    ).resolves.toBe(registry);

    expect(getChannelRegistry()).toBe(registry);
    expect(adapters.map((adapter) => adapter.id)).toEqual([
      "telegram:bot-a",
      "telegram:bot-b",
      "slack:workspace",
    ]);
    expect(adapters.some((adapter) => adapter.stopped())).toBe(false);
    const report = logs.find((line) =>
      line.includes("Failed to start requested channel listeners."),
    );
    expect(report).toContain("telegram/bot-slow: Telegram bot init timed out");
    expect(report).not.toContain("bot-a");
    expect(report).not.toContain("--install-channel-runtimes");

    // The failed account is retried in the background without a restart.
    for (let i = 0; i < 50 && slowAttempts < 2; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(slowAttempts).toBe(2);
    expect(registry.getAdapter("telegram", "bot-slow")?.isRunning()).toBe(true);
    expect(logs).toContain("[Channels] retry succeeded for telegram/bot-slow");
  });

  test("initializeChannels still fails when no requested account starts", async () => {
    __testOverrideLoadChannelAccounts((channelId) =>
      channelId === "telegram" ? [makeTelegramAccount("bot-slow")] : [],
    );
    __testOverrideSaveChannelAccounts(() => {});
    const registry = new ChannelRegistry();
    registry.startChannelAccount = async () => {
      throw new Error("Telegram bot init timed out after 15000ms");
    };

    await expect(
      initializeChannels(["telegram"], { failOnStartupError: true }),
    ).rejects.toBeInstanceOf(ChannelInitializationError);
    expect(getChannelRegistry()).toBeNull();
  });

  test("startup failure report suggests installing runtimes only when one is missing", () => {
    const timeout = formatChannelStartupFailures([
      {
        channelId: "telegram",
        accountId: "bot-slow",
        error: "Telegram bot init timed out after 15000ms",
      },
    ]);
    expect(timeout).not.toContain("install");

    const missing = formatChannelStartupFailures([
      {
        channelId: "telegram",
        accountId: "bot-slow",
        error: "Telegram bot init timed out after 15000ms",
      },
      {
        channelId: "slack",
        accountId: "workspace",
        error:
          "Slack support is not installed. Run: letta channels install slack or start the listener with --install-channel-runtimes.",
      },
    ]);
    expect(missing).toContain(
      "Install missing runtimes with: letta server --channels slack --install-channel-runtimes",
    );
    expect(missing).toContain("  letta channels install slack");
    expect(missing).not.toContain("letta channels install telegram");
  });
});
