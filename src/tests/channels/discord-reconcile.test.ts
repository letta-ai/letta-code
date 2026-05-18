import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import {
  __testOverrideLoadChannelAccounts,
  __testOverrideSaveChannelAccounts,
  clearChannelAccountStores,
} from "../../channels/accounts";
import {
  __testOverrideLoadRoutes,
  __testOverrideSaveRoutes,
  addRoute,
  clearAllRoutes,
  getRoute,
} from "../../channels/routing";

mock.module("../../backend/api/client", () => ({
  getClient: async () => ({}),
}));

// Helper to add a Discord guild channel route to the in-memory store,
// mimicking routes created by the Discord adapter.
function addDiscordRoute(overrides: {
  chatId: string;
  threadId?: string | null;
  accountId?: string;
  agentId?: string;
  conversationId?: string;
}) {
  addRoute("discord", {
    accountId: overrides.accountId ?? "discord-bot",
    chatId: overrides.chatId,
    chatType: "channel",
    threadId: overrides.threadId ?? null,
    agentId: overrides.agentId ?? "agent-1",
    conversationId: overrides.conversationId ?? "conv-1",
    enabled: true,
    createdAt: "2026-05-01T00:00:00.000Z",
  });
}

describe("Discord route reconciliation", () => {
  function resetState(): void {
    clearChannelAccountStores();
    clearAllRoutes();
    __testOverrideLoadChannelAccounts(null);
    __testOverrideSaveChannelAccounts(null);
    __testOverrideLoadRoutes(null);
    __testOverrideSaveRoutes(null);
  }

  beforeEach(() => {
    resetState();

    // Default: Discord bot with allowed_channels configured
    __testOverrideLoadChannelAccounts(() => [
      {
        channel: "discord",
        accountId: "discord-bot",
        enabled: true,
        token: "discord-token",
        agentId: "agent-1",
        defaultPermissionMode: "standard",
        dmPolicy: "pairing",
        allowedUsers: [],
        allowedChannels: ["channel-alpha", "channel-beta"],
        createdAt: "2026-04-11T00:00:00.000Z",
        updatedAt: "2026-04-11T00:00:00.000Z",
      },
    ]);
    __testOverrideSaveChannelAccounts(() => {});
    __testOverrideLoadRoutes(() => null);
    __testOverrideSaveRoutes(() => {});
  });

  afterEach(async () => {
    // Clean up the ChannelRegistry singleton if one was created
    const { getChannelRegistry } = await import("../../channels/registry");
    const registry = getChannelRegistry();
    if (registry) {
      await registry.stopAll();
    }
    resetState();
  });

  afterAll(() => {
    mock.restore();
  });

  // ── Dry-run tests ─────────────────────────────────────────────

  test("dry-run: detects stale route not in allowed_channels", async () => {
    addDiscordRoute({ chatId: "channel-alpha" }); // allowed
    addDiscordRoute({ chatId: "channel-gamma" }); // NOT allowed

    const { reconcileRoutesForChannel } = await import(
      "../../channels/reconcile"
    );
    const result = reconcileRoutesForChannel("discord", "discord-bot");

    expect(result.channel).toBe("discord");
    expect(result.totalRoutesChecked).toBe(2);
    expect(result.staleRoutes).toHaveLength(1);
    expect(result.staleRoutes[0]?.route.chatId).toBe("channel-gamma");
    expect(result.staleRoutes[0]?.reason).toContain("not in the allowed_channels");
    expect(result.staleRoutes[0]?.canResolve).toBe(true);
    expect(result.staleRoutes[0]?.resolvedGateChannelId).toBe("channel-gamma");
    expect(result.removedRoutes).toHaveLength(0);
    expect(result.skippedByPolicy).toHaveLength(0);
  });

  test("dry-run: no stale routes when all routes are in allowed_channels", async () => {
    addDiscordRoute({ chatId: "channel-alpha" });
    addDiscordRoute({ chatId: "channel-beta" });

    const { reconcileRoutesForChannel } = await import(
      "../../channels/reconcile"
    );
    const result = reconcileRoutesForChannel("discord", "discord-bot");

    expect(result.totalRoutesChecked).toBe(2);
    expect(result.staleRoutes).toHaveLength(0);
  });

  test("dry-run: no stale routes when allowed_channels is empty (all channels allowed)", async () => {
    // Override account to have empty allowedChannels
    clearChannelAccountStores();
    __testOverrideLoadChannelAccounts(() => [
      {
        channel: "discord",
        accountId: "discord-bot",
        enabled: true,
        token: "discord-token",
        agentId: "agent-1",
        defaultPermissionMode: "standard",
        dmPolicy: "pairing",
        allowedUsers: [],
        allowedChannels: [] as string[],
        createdAt: "2026-04-11T00:00:00.000Z",
        updatedAt: "2026-04-11T00:00:00.000Z",
      },
    ]);

    addDiscordRoute({ chatId: "channel-alpha" });
    addDiscordRoute({ chatId: "channel-gamma" });

    const { reconcileRoutesForChannel } = await import(
      "../../channels/reconcile"
    );
    const result = reconcileRoutesForChannel("discord", "discord-bot");

    expect(result.totalRoutesChecked).toBe(2);
    expect(result.staleRoutes).toHaveLength(0);
  });

  test("dry-run: ignores DM routes", async () => {
    // Add a direct DM route (chatType: "direct") — should be skipped
    addRoute("discord", {
      accountId: "discord-bot",
      chatId: "dm-user-1",
      chatType: "direct",
      threadId: null,
      agentId: "agent-1",
      conversationId: "conv-1",
      enabled: true,
      createdAt: "2026-05-01T00:00:00.000Z",
    });
    // Add a guild channel route that IS allowed — should not be stale
    addDiscordRoute({ chatId: "channel-alpha" });

    const { reconcileRoutesForChannel } = await import(
      "../../channels/reconcile"
    );
    const result = reconcileRoutesForChannel("discord", "discord-bot");

    expect(result.totalRoutesChecked).toBe(2);
    // DM route is skipped; channel-alpha is allowed → no stale routes
    expect(result.staleRoutes).toHaveLength(0);
  });

  test("dry-run: reports thread routes as indeterminate", async () => {
    // A thread route: chatId = thread ID, threadId = same ID
    addDiscordRoute({
      chatId: "thread-1",
      threadId: "thread-1",
    });

    const { reconcileRoutesForChannel } = await import(
      "../../channels/reconcile"
    );
    const result = reconcileRoutesForChannel("discord", "discord-bot");

    expect(result.totalRoutesChecked).toBe(1);
    expect(result.staleRoutes).toHaveLength(1);
    expect(result.staleRoutes[0]?.canResolve).toBe(false);
    expect(result.staleRoutes[0]?.reason).toContain("parent channel ID is not stored");
    expect(result.staleRoutes[0]?.resolvedGateChannelId).toBe(null);
  });

  test("dry-run: no file mutation (save override not called)", async () => {
    addDiscordRoute({ chatId: "channel-alpha" });
    addDiscordRoute({ chatId: "channel-gamma" });

    // Reset save spy after route setup
    const saveCalled: string[] = [];
    __testOverrideSaveRoutes((channelId) => {
      saveCalled.push(channelId);
    });

    const { reconcileRoutesForChannel } = await import(
      "../../channels/reconcile"
    );
    reconcileRoutesForChannel("discord", "discord-bot");

    // Dry-run should NOT call saveRoutes
    expect(saveCalled).toHaveLength(0);
  });

  // ── Removal gating tests ──────────────────────────────────────

  test("--apply with remove_stale_conversations=false: stale route remains, policy gate logged", async () => {
    addDiscordRoute({ chatId: "channel-alpha" });
    addDiscordRoute({ chatId: "channel-gamma" });

    const { reconcileRoutesForChannel } = await import(
      "../../channels/reconcile"
    );
    const result = reconcileRoutesForChannel("discord", "discord-bot", {
      apply: true,
    });

    expect(result.totalRoutesChecked).toBe(2);
    expect(result.staleRoutes).toHaveLength(1);
    expect(result.removedRoutes).toHaveLength(0);
    expect(result.skippedByPolicy).toHaveLength(1);
    expect(result.skippedByPolicy[0]?.route.chatId).toBe("channel-gamma");
    expect(result.policyGateReason).toContain("remove_stale_conversations is false");

    // Route should still exist
    expect(
      getRoute("discord", "channel-gamma", "discord-bot", null),
    ).not.toBeNull();
  });

  test("--apply with remove_stale_conversations=true: stale route removed", async () => {
    // Override account to have removeStaleConversations=true
    clearChannelAccountStores();
    __testOverrideLoadChannelAccounts(() => [
      {
        channel: "discord",
        accountId: "discord-bot",
        enabled: true,
        token: "discord-token",
        agentId: "agent-1",
        defaultPermissionMode: "standard",
        dmPolicy: "pairing",
        allowedUsers: [],
        allowedChannels: ["channel-alpha"],
        removeStaleConversations: true,
        createdAt: "2026-04-11T00:00:00.000Z",
        updatedAt: "2026-04-11T00:00:00.000Z",
      },
    ]);

    addDiscordRoute({ chatId: "channel-alpha" });
    addDiscordRoute({ chatId: "channel-gamma" });

    const { reconcileRoutesForChannel } = await import(
      "../../channels/reconcile"
    );
    const result = reconcileRoutesForChannel("discord", "discord-bot", {
      apply: true,
    });

    expect(result.totalRoutesChecked).toBe(2);
    expect(result.staleRoutes).toHaveLength(1);
    expect(result.staleRoutes[0]?.route.chatId).toBe("channel-gamma");
    expect(result.removedRoutes).toHaveLength(1);
    expect(result.removedRoutes[0]?.chatId).toBe("channel-gamma");
    expect(result.skippedByPolicy).toHaveLength(0);

    // Allowed route should remain
    expect(
      getRoute("discord", "channel-alpha", "discord-bot", null),
    ).not.toBeNull();

    // Stale route should be removed
    expect(
      getRoute("discord", "channel-gamma", "discord-bot", null),
    ).toBeNull();
  });

  test("--apply with remove_stale_conversations=true: non-stale routes preserved", async () => {
    clearChannelAccountStores();
    __testOverrideLoadChannelAccounts(() => [
      {
        channel: "discord",
        accountId: "discord-bot",
        enabled: true,
        token: "discord-token",
        agentId: "agent-1",
        defaultPermissionMode: "standard",
        dmPolicy: "pairing",
        allowedUsers: [],
        allowedChannels: ["channel-alpha"],
        removeStaleConversations: true,
        createdAt: "2026-04-11T00:00:00.000Z",
        updatedAt: "2026-04-11T00:00:00.000Z",
      },
    ]);

    addDiscordRoute({ chatId: "channel-alpha" });
    addDiscordRoute({ chatId: "channel-beta" }); // NOT in allowed_channels -> stale

    const { reconcileRoutesForChannel } = await import(
      "../../channels/reconcile"
    );
    const result = reconcileRoutesForChannel("discord", "discord-bot", {
      apply: true,
    });

    // channel-alpha should be preserved
    expect(
      getRoute("discord", "channel-alpha", "discord-bot", null),
    ).not.toBeNull();

    // channel-beta should be removed
    expect(
      getRoute("discord", "channel-beta", "discord-bot", null),
    ).toBeNull();

    expect(result.removedRoutes).toHaveLength(1);
    expect(result.removedRoutes[0]?.chatId).toBe("channel-beta");
  });

  test("--apply with no stale routes: policyGateReason is null", async () => {
    addDiscordRoute({ chatId: "channel-alpha" });
    addDiscordRoute({ chatId: "channel-beta" });

    const { reconcileRoutesForChannel } = await import(
      "../../channels/reconcile"
    );
    const result = reconcileRoutesForChannel("discord", "discord-bot", {
      apply: true,
    });

    expect(result.totalRoutesChecked).toBe(2);
    expect(result.staleRoutes).toHaveLength(0);
    expect(result.removedRoutes).toHaveLength(0);
    expect(result.skippedByPolicy).toHaveLength(0);
    expect(result.policyGateReason).toBeNull();
  });

  // ── Mode map tests ───────────────────────────────────────────

  test("works with mode map (Record) format for allowed_channels", async () => {
    clearChannelAccountStores();
    __testOverrideLoadChannelAccounts(() => [
      {
        channel: "discord",
        accountId: "discord-bot",
        enabled: true,
        token: "discord-token",
        agentId: "agent-1",
        defaultPermissionMode: "standard",
        dmPolicy: "pairing",
        allowedUsers: [],
        allowedChannels: {
          "channel-alpha": "open",
          "channel-beta": "mention-only",
        },
        createdAt: "2026-04-11T00:00:00.000Z",
        updatedAt: "2026-04-11T00:00:00.000Z",
      },
    ]);

    addDiscordRoute({ chatId: "channel-alpha" }); // in mode map
    addDiscordRoute({ chatId: "channel-gamma" }); // NOT in mode map

    const { reconcileRoutesForChannel } = await import(
      "../../channels/reconcile"
    );
    const result = reconcileRoutesForChannel("discord", "discord-bot");

    expect(result.totalRoutesChecked).toBe(2);
    expect(result.staleRoutes).toHaveLength(1);
    expect(result.staleRoutes[0]?.route.chatId).toBe("channel-gamma");
  });

  // ── Thread parent resolution test ────────────────────────────

  test("thread stale detection: thread routes flagged as indeterminate, parent channel route checked directly", async () => {
    // Non-thread route in a channel that IS in allowed_channels
    addDiscordRoute({
      chatId: "channel-alpha",
      threadId: null,
    });

    // Thread route — parent channel is unknown
    addDiscordRoute({
      chatId: "thread-of-gamma",
      threadId: "thread-of-gamma",
    });

    const { reconcileRoutesForChannel } = await import(
      "../../channels/reconcile"
    );
    const result = reconcileRoutesForChannel("discord", "discord-bot");

    expect(result.totalRoutesChecked).toBe(2);

    // channel-alpha IS in allowedChannels — not stale
    const nonThreadStale = result.staleRoutes.find(
      (r) => r.route.chatId === "channel-alpha",
    );
    expect(nonThreadStale).toBeUndefined();

    // Thread route is indeterminate
    const threadStale = result.staleRoutes.find(
      (r) => r.route.chatId === "thread-of-gamma",
    );
    expect(threadStale).toBeDefined();
    expect(threadStale?.canResolve).toBe(false);
    expect(threadStale?.reason).toContain("parent channel ID is not stored");
  });

  // ── Log assertions ───────────────────────────────────────────

  test("blocked-delivery diagnostics contain key identifiers and reason", async () => {
    // This test validates the diagnostics format in registry.ts
    // by checking the inbound delivery gate log output
    const logSpy = mock(() => {});
    const originalLog = console.log;
    console.log = logSpy;

    try {
      const { ChannelRegistry } = await import("../../channels/registry");

      // Import inline to reset state
      clearChannelAccountStores();
      clearAllRoutes();

      // Set up account with allowed_channels that excludes the test channel
      __testOverrideLoadChannelAccounts(() => [
        {
          channel: "discord",
          accountId: "discord-bot",
          enabled: true,
          token: "discord-token",
          agentId: "agent-1",
          defaultPermissionMode: "standard",
          dmPolicy: "pairing",
          allowedUsers: [],
          allowedChannels: ["channel-alpha"],
          createdAt: "2026-04-11T00:00:00.000Z",
          updatedAt: "2026-04-11T00:00:00.000Z",
        },
      ]);

      // Pre-add a route for the disallowed channel to simulate the case
      // where a route was created when the channel was allowed, then the
      // allowed_channels config changed. ensureDiscordRoute finds the
      // existing route, then the delivery-time gate fires.
      addRoute("discord", {
        accountId: "discord-bot",
        chatId: "channel-gamma",
        chatType: "channel",
        threadId: null,
        agentId: "agent-1",
        conversationId: "conv-existing",
        enabled: true,
        createdAt: "2026-05-01T00:00:00.000Z",
      });

      const registry = new ChannelRegistry();
      const adapter: import("../../channels/types").ChannelAdapter = {
        id: "discord:discord-bot",
        channelId: "discord",
        accountId: "discord-bot",
        name: "Discord",
        start: async () => {},
        stop: async () => {},
        isRunning: () => true,
        sendMessage: async () => ({ messageId: "outbound-1" }),
        sendDirectReply: async () => {},
        prepareInboundMessage: async (msg) => msg,
      };
      registry.registerAdapter(adapter);
      registry.setReady();

      // Send a message from a disallowed guild channel (non-thread)
      await adapter.onMessage?.({
        channel: "discord",
        accountId: "discord-bot",
        chatId: "channel-gamma",
        senderId: "user-1",
        senderName: "TestUser",
        text: "hello",
        timestamp: Date.now(),
        messageId: "msg-1",
        threadId: null,
        chatType: "channel",
        isMention: false,
      });

      // The handler first calls ensureDiscordRoute which creates a route,
      // then checks the delivery-time gate which should block + log
      const logCall = logSpy.mock.calls.find(
        (call: unknown[]) =>
          typeof call[0] === "string" &&
          call[0].includes("Delivery blocked by allowed_channels policy"),
      );
      expect(logCall).toBeDefined();

      if (logCall) {
        const payload = JSON.parse(logCall[1]);
        expect(payload.accountId).toBe("discord-bot");
        expect(payload.chatId).toBe("channel-gamma");
        expect(payload.threadId).toBeNull();
        expect(payload.resolvedParentId).toBeNull();
        expect(payload.reason).toContain("not in allowed_channels");
      }
    } finally {
      console.log = originalLog;
    }
  });
});
