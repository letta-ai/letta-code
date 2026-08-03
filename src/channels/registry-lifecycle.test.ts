import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  __testOverrideLoadChannelAccounts,
  __testOverrideSaveChannelAccounts,
  clearChannelAccountStores,
} from "@/channels/accounts";
import { createRoutedRuntimeRegistrationRefresher } from "@/channels/gateway-local";
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
} from "@/channels/routing";
import {
  bindChannelTarget,
  removeChannelRouteLive,
  updateChannelRouteLive,
} from "@/channels/service";
import {
  __testOverrideLoadTargetStore,
  __testOverrideSaveTargetStore,
  clearTargetStores,
  upsertChannelTarget,
} from "@/channels/targets";
import type {
  ChannelAdapter,
  ChannelTurnSource,
  SignalChannelAccount,
} from "@/channels/types";
import type { RuntimeScope } from "@/types/app-server-protocol";

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
  function observeGatewayRegistrationRefreshes(registry: ChannelRegistry): {
    flush: () => Promise<void>;
    latestSources: (
      agentId: string,
      conversationId: string,
    ) => ChannelTurnSource[];
  } {
    const registrations: Array<{
      runtime: RuntimeScope;
      sources: ChannelTurnSource[];
    }> = [];
    const knownRuntimes = new Map<string, RuntimeScope>();
    const registrar = {
      getKnownRuntimes: () => [...knownRuntimes.values()],
      registerRuntime: async (
        runtime: RuntimeScope,
        sources: ChannelTurnSource[],
      ) => {
        knownRuntimes.set(
          `${runtime.agent_id}:${runtime.conversation_id}`,
          runtime,
        );
        registrations.push({ runtime, sources });
      },
    };
    const refresher = createRoutedRuntimeRegistrationRefresher(
      registry,
      registrar,
    );
    const refreshes: Promise<void>[] = [];
    registry.setEventHandler((event) => {
      if (
        event.type === "routes_updated" ||
        event.type === "channel_account_state_updated"
      ) {
        refreshes.push(refresher.refresh());
      }
    });
    return {
      flush: async () => {
        while (refreshes.length > 0) {
          await Promise.all(refreshes.splice(0));
        }
      },
      latestSources: (agentId, conversationId) =>
        registrations.findLast(
          ({ runtime }) =>
            runtime.agent_id === agentId &&
            runtime.conversation_id === conversationId,
        )?.sources ?? [],
    };
  }

  beforeEach(() => {
    __testOverrideLoadRoutes(() => null);
    __testOverrideSaveRoutes(() => {});
    __testOverrideLoadPairingStore(() => null);
    __testOverrideSavePairingStore(() => {});
    __testOverrideLoadTargetStore(() => {});
    __testOverrideSaveTargetStore(() => {});
  });

  afterEach(async () => {
    const registry = getChannelRegistry();
    if (registry) {
      await registry.stopAll();
    }
    clearAllRoutes();
    clearPairingStores();
    clearTargetStores();
    clearChannelAccountStores();
    __testOverrideLoadRoutes(null);
    __testOverrideSaveRoutes(null);
    __testOverrideLoadPairingStore(null);
    __testOverrideSavePairingStore(null);
    __testOverrideLoadTargetStore(null);
    __testOverrideSaveTargetStore(null);
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

  test("only exposes enabled outbound routes backed by running adapters", () => {
    const registry = new ChannelRegistry();
    const adapter = (accountId: string, running: boolean) => ({
      id: `slack:${accountId}`,
      channelId: "slack",
      accountId,
      name: "Slack",
      start: async () => {},
      stop: async () => {},
      isRunning: () => running,
      sendMessage: async () => ({ messageId: "msg-1" }),
      sendDirectReply: async () => {},
    });
    registry.registerAdapter(adapter("running", true));
    registry.registerAdapter(adapter("stopped", false));
    const addTestRoute = (
      accountId: string,
      conversationId: string,
      options: { enabled?: boolean; outboundEnabled?: boolean } = {},
    ) =>
      addRoute("slack", {
        accountId,
        chatId: `chat-${conversationId}`,
        agentId: "agent-1",
        conversationId,
        enabled: options.enabled ?? true,
        outboundEnabled: options.outboundEnabled ?? true,
        createdAt: "2026-07-09T00:00:00.000Z",
      });
    addTestRoute("running", "eligible");
    addTestRoute("running", "disabled", { enabled: false });
    addTestRoute("running", "listen-only", { outboundEnabled: false });
    addTestRoute("stopped", "stopped");

    expect(registry.resolveRoutedRuntimeSources()).toEqual([
      {
        agentId: "agent-1",
        conversationId: "eligible",
        sources: [
          expect.objectContaining({
            channel: "slack",
            accountId: "running",
            conversationId: "eligible",
          }),
        ],
      },
    ]);
  });

  test("serializes routed runtime refreshes so stale registration cannot win", async () => {
    const registry = new ChannelRegistry();
    let running = true;
    registry.registerAdapter({
      id: "telegram:acct-telegram",
      channelId: "telegram",
      accountId: "acct-telegram",
      name: "Telegram",
      start: async () => {
        running = true;
      },
      stop: async () => {
        running = false;
      },
      isRunning: () => running,
      sendMessage: async () => ({ messageId: "msg-1" }),
      sendDirectReply: async () => {},
    });
    addRoute("telegram", {
      accountId: "acct-telegram",
      chatId: "chat-1",
      agentId: "agent-1",
      conversationId: "conv-1",
      enabled: true,
      createdAt: "2026-07-09T00:00:00.000Z",
    });

    let releaseFirstRegistration: () => void = () => {};
    const firstRegistrationBlocked = new Promise<void>((resolve) => {
      releaseFirstRegistration = resolve;
    });
    let markFirstRegistrationStarted: () => void = () => {};
    const firstRegistrationStarted = new Promise<void>((resolve) => {
      markFirstRegistrationStarted = resolve;
    });
    const registeredSourceCounts: number[] = [];
    let activeRegistrations = 0;
    let maxActiveRegistrations = 0;
    const refresher = createRoutedRuntimeRegistrationRefresher(registry, {
      getKnownRuntimes: () => [
        { agent_id: "agent-1", conversation_id: "conv-1" },
      ],
      registerRuntime: async (_runtime, sources) => {
        activeRegistrations++;
        maxActiveRegistrations = Math.max(
          maxActiveRegistrations,
          activeRegistrations,
        );
        registeredSourceCounts.push(sources?.length ?? 0);
        if (registeredSourceCounts.length === 1) {
          markFirstRegistrationStarted();
          await firstRegistrationBlocked;
        }
        activeRegistrations--;
      },
    });

    const firstRefresh = refresher.refresh();
    await firstRegistrationStarted;
    running = false;
    const secondRefresh = refresher.refresh();
    releaseFirstRegistration();
    await Promise.all([firstRefresh, secondRefresh]);

    expect(registeredSourceCounts).toEqual([1, 0]);
    expect(maxActiveRegistrations).toBe(1);
  });

  test("non-WhatsApp adapter stop and restart refresh scheduled tool registration", async () => {
    const registry = new ChannelRegistry();
    let running = true;
    const adapter: ChannelAdapter = {
      id: "telegram:acct-telegram",
      channelId: "telegram",
      accountId: "acct-telegram",
      name: "Telegram",
      start: async () => {
        running = true;
      },
      stop: async () => {
        running = false;
      },
      isRunning: () => running,
      sendMessage: async () => ({ messageId: "msg-1" }),
      sendDirectReply: async () => {},
    };
    registry.registerAdapter(adapter);
    const registrationRefreshes = observeGatewayRegistrationRefreshes(registry);

    addRoute("telegram", {
      accountId: "acct-telegram",
      chatId: "chat-1",
      agentId: "agent-1",
      conversationId: "conv-1",
      enabled: true,
      createdAt: "2026-07-09T00:00:00.000Z",
    });
    await registrationRefreshes.flush();
    expect(
      registrationRefreshes.latestSources("agent-1", "conv-1"),
    ).toHaveLength(1);

    await registry.stopChannelAccount("telegram", "acct-telegram");
    await registrationRefreshes.flush();
    expect(registrationRefreshes.latestSources("agent-1", "conv-1")).toEqual(
      [],
    );

    registry.registerAdapter(adapter);
    await registry.startAll();
    await registrationRefreshes.flush();
    expect(registrationRefreshes.latestSources("agent-1", "conv-1")).toEqual([
      expect.objectContaining({
        channel: "telegram",
        agentId: "agent-1",
        conversationId: "conv-1",
      }),
    ]);
  });

  test("live service route moves refresh old and new runtime registrations", async () => {
    const registry = new ChannelRegistry();
    registry.registerAdapter({
      id: "slack:docsbot",
      channelId: "slack",
      accountId: "docsbot",
      name: "Slack",
      start: async () => {},
      stop: async () => {},
      isRunning: () => true,
      sendMessage: async () => ({ messageId: "msg-1" }),
      sendDirectReply: async () => {},
    });
    const registrationRefreshes = observeGatewayRegistrationRefreshes(registry);

    upsertChannelTarget("slack", {
      targetId: "target-C123",
      targetType: "channel",
      chatId: "C123",
      label: "#scheduled",
      accountId: "docsbot",
      discoveredAt: "2026-07-09T00:00:00.000Z",
      lastSeenAt: "2026-07-09T00:00:00.000Z",
    });
    bindChannelTarget(
      "slack",
      "target-C123",
      "agent-old",
      "conv-old",
      "docsbot",
    );
    await registrationRefreshes.flush();
    expect(
      registrationRefreshes.latestSources("agent-old", "conv-old"),
    ).toHaveLength(1);

    updateChannelRouteLive("slack", "C123", "agent-new", "conv-new", "docsbot");
    await registrationRefreshes.flush();
    expect(
      registrationRefreshes.latestSources("agent-old", "conv-old"),
    ).toEqual([]);
    expect(
      registrationRefreshes.latestSources("agent-new", "conv-new"),
    ).toHaveLength(1);

    expect(removeChannelRouteLive("slack", "C123", "docsbot")).toBe(true);
    await registrationRefreshes.flush();
    expect(
      registrationRefreshes.latestSources("agent-old", "conv-old"),
    ).toEqual([]);
    expect(
      registrationRefreshes.latestSources("agent-new", "conv-new"),
    ).toEqual([]);
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
