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
  getChannelRegistry,
  initializeChannels,
} from "@/channels/registry";
import {
  __testOverrideLoadRoutes,
  __testOverrideSaveRoutes,
  addRoute,
  clearAllRoutes,
  removeRoute,
} from "@/channels/routing";
import type { SignalChannelAccount } from "@/channels/types";

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

  test("stopAll destroys the singleton after adapter stop failures", async () => {
    const registry = new ChannelRegistry();
    registry.registerAdapter({
      id: "telegram:default",
      channelId: "telegram",
      accountId: "default",
      name: "Telegram",
      start: async () => {},
      stop: async () => {
        throw new Error("stop failed");
      },
      isRunning: () => true,
      sendMessage: async () => ({ messageId: "msg-1" }),
      sendDirectReply: async () => {},
    });

    await expect(registry.stopAll()).rejects.toThrow("stop failed");
    expect(getChannelRegistry()).toBeNull();
  });

  test("route-derived recovery sources require a running adapter", () => {
    const registry = new ChannelRegistry();
    let running = true;
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

    addRoute("slack", {
      accountId: "acct-slack",
      chatId: "C123",
      chatType: "channel",
      threadId: "1712790000.000050",
      agentId: "agent-1",
      conversationId: "conv-1",
      enabled: true,
      outboundEnabled: false,
      createdAt: "2026-07-09T00:00:00.000Z",
    });
    expect(registry.resolveTurnSourcesForScope("agent-1", "conv-1")).toEqual(
      [],
    );

    running = false;
    expect(registry.resolveTurnSourcesForScope("agent-1", "conv-1")).toEqual(
      [],
    );
  });

  test("route changes request runtime surface refreshes", () => {
    const registry = new ChannelRegistry();
    const refreshed: string[] = [];
    registry.setEventHandler((event) => {
      if (event.type === "channel_runtime_routes_updated") {
        refreshed.push(`${event.agentId}:${event.conversationId}`);
      }
    });
    const route = {
      chatId: "chat-1",
      agentId: "agent-a",
      conversationId: "conv-a",
      enabled: true,
      createdAt: "2026-07-09T00:00:00.000Z",
    };

    addRoute("telegram", route);
    addRoute("telegram", {
      ...route,
      agentId: "agent-b",
      conversationId: "conv-b",
    });
    removeRoute("telegram", "chat-1");

    expect(refreshed).toEqual([
      "agent-a:conv-a",
      "agent-a:conv-a",
      "agent-b:conv-b",
      "agent-b:conv-b",
    ]);
  });

  test("stopping an adapter requests runtime surface refresh", async () => {
    const registry = new ChannelRegistry();
    const refreshed: string[] = [];
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
      agentId: "agent-1",
      conversationId: "conv-1",
      enabled: true,
      createdAt: "2026-07-09T00:00:00.000Z",
    });
    registry.setEventHandler((event) => {
      if (event.type === "channel_runtime_routes_updated") {
        refreshed.push(`${event.agentId}:${event.conversationId}`);
      }
    });

    await registry.stopChannelAccount("slack", "acct-slack");

    expect(refreshed).toEqual(["agent-1:conv-1"]);
  });

  test("failed adapter stops still refresh runtime eligibility", async () => {
    const registry = new ChannelRegistry();
    const refreshed: string[] = [];
    let running = true;
    registry.registerAdapter({
      id: "slack:acct-slack",
      channelId: "slack",
      accountId: "acct-slack",
      name: "Slack",
      start: async () => {},
      stop: async () => {
        running = false;
        throw new Error("stop failed after shutdown");
      },
      isRunning: () => running,
      sendMessage: async () => ({ messageId: "msg-1" }),
      sendDirectReply: async () => {},
    });
    addRoute("slack", {
      accountId: "acct-slack",
      chatId: "C123",
      agentId: "agent-1",
      conversationId: "conv-1",
      enabled: true,
      createdAt: "2026-07-09T00:00:00.000Z",
    });
    registry.setEventHandler((event) => {
      if (event.type === "channel_runtime_routes_updated") {
        refreshed.push(`${event.agentId}:${event.conversationId}`);
      }
    });

    await expect(
      registry.stopChannelAccount("slack", "acct-slack"),
    ).rejects.toThrow("stop failed after shutdown");

    expect(refreshed).toEqual(["agent-1:conv-1"]);
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
