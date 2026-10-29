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
import { MissingChannelRuntimeError } from "@/channels/runtime-deps";
import type {
  ChannelAdapter,
  SignalChannelAccount,
  TelegramChannelAccount,
} from "@/channels/types";

function telegramAccount(accountId: string): TelegramChannelAccount {
  return {
    channel: "telegram",
    accountId,
    enabled: true,
    token: `token-${accountId}`,
    binding: { agentId: null, conversationId: null },
    dmPolicy: "pairing",
    allowedUsers: [],
    createdAt: "2026-06-17T00:00:00.000Z",
    updatedAt: "2026-06-17T00:00:00.000Z",
  };
}

function fakeAdapter(
  channelId: string,
  accountId: string,
  onStop: (id: string) => void,
): ChannelAdapter {
  let running = true;
  const id = `${channelId}:${accountId}`;
  return {
    id,
    channelId,
    accountId,
    name: id,
    start: async () => {
      running = true;
    },
    stop: async () => {
      running = false;
      onStop(id);
    },
    isRunning: () => running,
    sendMessage: async () => ({ messageId: "msg-1" }),
    sendDirectReply: async () => {},
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
  test("initializeChannels keeps healthy accounts running when one account fails", async () => {
    __testOverrideLoadChannelAccounts((channelId) =>
      channelId === "telegram"
        ? [
            telegramAccount("bot-a"),
            telegramAccount("bot-slow"),
            telegramAccount("bot-b"),
          ]
        : [],
    );
    __testOverrideSaveChannelAccounts(() => {});
    const registry = new ChannelRegistry();
    const stopped: string[] = [];
    registry.startChannelAccount = async (channelId, accountId) => {
      if (accountId === "bot-slow") {
        throw new Error("Telegram bot init timed out after 15000ms");
      }
      registry.registerAdapter(
        fakeAdapter(channelId, accountId, (id) => stopped.push(id)),
      );
      return true;
    };
    const logs: string[] = [];

    await expect(
      initializeChannels(["telegram"], {
        failOnStartupError: true,
        logger: (message) => logs.push(message),
      }),
    ).resolves.toBe(registry);

    expect(stopped).toEqual([]);
    expect(getChannelRegistry()).toBe(registry);
    expect(registry.getAdapter("telegram", "bot-a")?.isRunning()).toBe(true);
    expect(registry.getAdapter("telegram", "bot-b")?.isRunning()).toBe(true);
    const report = logs.find((line) =>
      line.includes("Failed to start requested channel listeners."),
    );
    expect(report).toContain(
      "- telegram/bot-slow: Telegram bot init timed out after 15000ms",
    );
    expect(report).not.toContain("bot-a");
    expect(report).not.toContain("--install-channel-runtimes");
  });

  test("initializeChannels fails startup when no requested account starts", async () => {
    __testOverrideLoadChannelAccounts((channelId) =>
      channelId === "telegram" ? [telegramAccount("bot-slow")] : [],
    );
    __testOverrideSaveChannelAccounts(() => {});
    const registry = new ChannelRegistry();
    registry.startChannelAccount = async () => {
      throw new Error("Telegram bot init timed out after 15000ms");
    };

    const error = await initializeChannels(["telegram"], {
      failOnStartupError: true,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ChannelInitializationError);
    expect((error as ChannelInitializationError).message).not.toContain(
      "--install-channel-runtimes",
    );
    expect(getChannelRegistry()).toBeNull();
  });

  test("startup failure hint only suggests installing missing runtimes", () => {
    const timeout = formatChannelStartupFailures([
      {
        channelId: "telegram",
        accountId: "bot-slow",
        error: "Telegram bot init timed out after 15000ms",
      },
    ]);
    expect(timeout).not.toContain("--install-channel-runtimes");
    expect(timeout).not.toContain("letta channels install");

    const missing = formatChannelStartupFailures([
      {
        channelId: "telegram",
        accountId: "bot-slow",
        error: "Telegram bot init timed out after 15000ms",
      },
      {
        channelId: "slack",
        accountId: "acct-slack",
        error: new MissingChannelRuntimeError("slack").message,
        missingRuntime: true,
      },
    ]);
    expect(missing).toContain(
      "Install missing runtimes with: letta server --channels slack --install-channel-runtimes",
    );
    expect(missing).toContain("  letta channels install slack");
    expect(missing).not.toContain("letta channels install telegram");
  });
});
