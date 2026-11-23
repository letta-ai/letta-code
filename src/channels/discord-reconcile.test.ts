import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import {
  __testOverrideLoadChannelAccounts,
  __testOverrideSaveChannelAccounts,
  clearChannelAccountStores,
} from "@/channels/accounts";
import {
  __testOverrideLoadRoutes,
  __testOverrideSaveRoutes,
  addRoute,
  clearAllRoutes,
  getRoute,
} from "@/channels/routing";

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
  beforeAll(() => {
    mock.module("@/backend/api/client", () => ({
      getServerUrl: () => "https://api.letta.com",
      getClient: async () => ({}),
    }));
  });

  afterAll(() => {
    mock.restore();
  });
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
    const { getChannelRegistry } = await import("@/channels/registry");
    const registry = getChannelRegistry();
    if (registry) {
      await registry.stopAll();
    }
    resetState();
  });

  afterAll(() => {
    mock.restore();
  });

  test("dry-run: detects stale route not in allowed_channels", async () => {
    addDiscordRoute({ chatId: "channel-alpha" });
    addDiscordRoute({ chatId: "channel-gamma" });

    const { reconcileRoutesForChannel } = await import("@/channels/reconcile");
    const result = reconcileRoutesForChannel("discord", "discord-bot");

    expect(result.channel).toBe("discord");
    expect(result.totalRoutesChecked).toBe(2);
    expect(result.staleRoutes).toHaveLength(1);
    expect(result.staleRoutes[0]?.route.chatId).toBe("channel-gamma");
    expect(result.staleRoutes[0]?.reason).toContain(
      "not in the allowed_channels",
    );
    expect(result.staleRoutes[0]?.canResolve).toBe(true);
    expect(result.staleRoutes[0]?.resolvedGateChannelId).toBe("channel-gamma");
    expect(result.removedRoutes).toHaveLength(0);
    expect(result.skippedByPolicy).toHaveLength(0);
  });

  test("dry-run: no stale routes when all routes are in allowed_channels", async () => {
    addDiscordRoute({ chatId: "channel-alpha" });
    addDiscordRoute({ chatId: "channel-beta" });

    const { reconcileRoutesForChannel } = await import("@/channels/reconcile");
    const result = reconcileRoutesForChannel("discord", "discord-bot");

    expect(result.totalRoutesChecked).toBe(2);
    expect(result.staleRoutes).toHaveLength(0);
  });

  test("dry-run: no stale routes when allowed_channels is empty (all channels allowed)", async () => {
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

    const { reconcileRoutesForChannel } = await import("@/channels/reconcile");
    const result = reconcileRoutesForChannel("discord", "discord-bot");

    expect(result.totalRoutesChecked).toBe(2);
    expect(result.staleRoutes).toHaveLength(0);
  });

  test("dry-run: ignores DM routes", async () => {
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
    addDiscordRoute({ chatId: "channel-alpha" });

    const { reconcileRoutesForChannel } = await import("@/channels/reconcile");
    const result = reconcileRoutesForChannel("discord", "discord-bot");

    expect(result.totalRoutesChecked).toBe(2);
    expect(result.staleRoutes).toHaveLength(0);
  });

  test("dry-run: reports thread routes as indeterminate", async () => {
    addDiscordRoute({
      chatId: "thread-1",
      threadId: "thread-1",
    });

    const { reconcileRoutesForChannel } = await import("@/channels/reconcile");
    const result = reconcileRoutesForChannel("discord", "discord-bot");

    expect(result.totalRoutesChecked).toBe(1);
    expect(result.staleRoutes).toHaveLength(1);
    expect(result.staleRoutes[0]?.canResolve).toBe(false);
    expect(result.staleRoutes[0]?.reason).toContain(
      "parent channel ID is not stored",
    );
    expect(result.staleRoutes[0]?.resolvedGateChannelId).toBe(null);
  });

  test("dry-run: no file mutation (save override not called)", async () => {
    addDiscordRoute({ chatId: "channel-alpha" });
    addDiscordRoute({ chatId: "channel-gamma" });

    const saveCalled: string[] = [];
    __testOverrideSaveRoutes((channelId) => {
      saveCalled.push(channelId);
    });

    const { reconcileRoutesForChannel } = await import("@/channels/reconcile");
    reconcileRoutesForChannel("discord", "discord-bot");

    expect(saveCalled).toHaveLength(0);
  });

  test("--apply with remove_stale_routes=false: stale route remains, policy gate logged", async () => {
    addDiscordRoute({ chatId: "channel-alpha" });
    addDiscordRoute({ chatId: "channel-gamma" });

    const { reconcileRoutesForChannel } = await import("@/channels/reconcile");
    const result = reconcileRoutesForChannel("discord", "discord-bot", {
      apply: true,
    });

    expect(result.totalRoutesChecked).toBe(2);
    expect(result.staleRoutes).toHaveLength(1);
    expect(result.removedRoutes).toHaveLength(0);
    expect(result.skippedByPolicy).toHaveLength(1);
    expect(result.skippedByPolicy[0]?.route.chatId).toBe("channel-gamma");
    expect(result.policyGateReason).toContain("remove_stale_routes is false");

    expect(
      getRoute("discord", "channel-gamma", "discord-bot", null),
    ).not.toBeNull();
  });

  test("--apply with remove_stale_routes=true: stale route removed", async () => {
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
        removeStaleRoutes: true,
        createdAt: "2026-04-11T00:00:00.000Z",
        updatedAt: "2026-04-11T00:00:00.000Z",
      },
    ]);

    addDiscordRoute({ chatId: "channel-alpha" });
    addDiscordRoute({ chatId: "channel-gamma" });

    const { reconcileRoutesForChannel } = await import("@/channels/reconcile");
    const result = reconcileRoutesForChannel("discord", "discord-bot", {
      apply: true,
    });

    expect(result.totalRoutesChecked).toBe(2);
    expect(result.staleRoutes).toHaveLength(1);
    expect(result.staleRoutes[0]?.route.chatId).toBe("channel-gamma");
    expect(result.removedRoutes).toHaveLength(1);
    expect(result.removedRoutes[0]?.chatId).toBe("channel-gamma");
    expect(result.skippedByPolicy).toHaveLength(0);

    expect(
      getRoute("discord", "channel-alpha", "discord-bot", null),
    ).not.toBeNull();

    expect(
      getRoute("discord", "channel-gamma", "discord-bot", null),
    ).toBeNull();
  });

  test("--apply with remove_stale_routes=true: non-stale routes preserved", async () => {
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
        removeStaleRoutes: true,
        createdAt: "2026-04-11T00:00:00.000Z",
        updatedAt: "2026-04-11T00:00:00.000Z",
      },
    ]);

    addDiscordRoute({ chatId: "channel-alpha" });
    addDiscordRoute({ chatId: "channel-beta" });

    const { reconcileRoutesForChannel } = await import("@/channels/reconcile");
    const result = reconcileRoutesForChannel("discord", "discord-bot", {
      apply: true,
    });

    expect(
      getRoute("discord", "channel-alpha", "discord-bot", null),
    ).not.toBeNull();

    expect(getRoute("discord", "channel-beta", "discord-bot", null)).toBeNull();

    expect(result.removedRoutes).toHaveLength(1);
    expect(result.removedRoutes[0]?.chatId).toBe("channel-beta");
  });

  test("--apply with no stale routes: policyGateReason is null", async () => {
    addDiscordRoute({ chatId: "channel-alpha" });
    addDiscordRoute({ chatId: "channel-beta" });

    const { reconcileRoutesForChannel } = await import("@/channels/reconcile");
    const result = reconcileRoutesForChannel("discord", "discord-bot", {
      apply: true,
    });

    expect(result.totalRoutesChecked).toBe(2);
    expect(result.staleRoutes).toHaveLength(0);
    expect(result.removedRoutes).toHaveLength(0);
    expect(result.skippedByPolicy).toHaveLength(0);
    expect(result.policyGateReason).toBeNull();
  });

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

    addDiscordRoute({ chatId: "channel-alpha" });
    addDiscordRoute({ chatId: "channel-gamma" });

    const { reconcileRoutesForChannel } = await import("@/channels/reconcile");
    const result = reconcileRoutesForChannel("discord", "discord-bot");

    expect(result.totalRoutesChecked).toBe(2);
    expect(result.staleRoutes).toHaveLength(1);
    expect(result.staleRoutes[0]?.route.chatId).toBe("channel-gamma");
  });

  test("wildcard mode map treats every non-thread guild route as allowed", async () => {
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
        allowedChannels: { "*": "open" },
        createdAt: "2026-04-11T00:00:00.000Z",
        updatedAt: "2026-04-11T00:00:00.000Z",
      },
    ]);

    addDiscordRoute({ chatId: "channel-alpha" });
    addDiscordRoute({ chatId: "channel-gamma" });

    const { reconcileRoutesForChannel } = await import("@/channels/reconcile");
    const result = reconcileRoutesForChannel("discord", "discord-bot");

    expect(result.totalRoutesChecked).toBe(2);
    expect(result.staleRoutes).toHaveLength(0);
  });

  test("thread stale detection: thread routes flagged as indeterminate, parent channel route checked directly", async () => {
    addDiscordRoute({
      chatId: "channel-alpha",
      threadId: null,
    });

    addDiscordRoute({
      chatId: "thread-of-gamma",
      threadId: "thread-of-gamma",
    });

    const { reconcileRoutesForChannel } = await import("@/channels/reconcile");
    const result = reconcileRoutesForChannel("discord", "discord-bot");

    expect(result.totalRoutesChecked).toBe(2);

    const nonThreadStale = result.staleRoutes.find(
      (r) => r.route.chatId === "channel-alpha",
    );
    expect(nonThreadStale).toBeUndefined();

    const threadStale = result.staleRoutes.find(
      (r) => r.route.chatId === "thread-of-gamma",
    );
    expect(threadStale).toBeDefined();
    expect(threadStale?.canResolve).toBe(false);
    expect(threadStale?.reason).toContain("parent channel ID is not stored");
  });

  test("blocked-delivery debug diagnostics contain key identifiers and reason", async () => {
    const debug = process.env.LETTA_DEBUG;
    const debugFile = process.env.LETTA_DEBUG_FILE;
    process.env.LETTA_DEBUG = "1";
    delete process.env.LETTA_DEBUG_FILE;
    const logSpy = spyOn(console, "error").mockImplementation(() => {});
    const stdoutSpy = spyOn(console, "log").mockImplementation(() => {});

    try {
      const { ChannelRegistry } = await import("@/channels/registry");

      clearChannelAccountStores();
      clearAllRoutes();

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
      const adapter: import("@/channels/types").ChannelAdapter = {
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

      expect(stdoutSpy).not.toHaveBeenCalled();
      const logCall = logSpy.mock.calls.find(
        (call: unknown[]) =>
          typeof call[0] === "string" &&
          call[0].includes("Delivery blocked by allowed_channels policy"),
      );
      expect(logCall).toBeDefined();

      if (logCall) {
        const json = String(logCall[0]).match(/\{.*\}/)?.[0];
        expect(json).toBeDefined();
        const payload = JSON.parse(json ?? "{}");
        expect(payload.accountId).toBe("discord-bot");
        expect(payload.chatId).toBe("channel-gamma");
        expect(payload.threadId).toBeNull();
        expect(payload.resolvedParentId).toBeNull();
        expect(payload.reason).toContain("not in allowed_channels");
      }
    } finally {
      logSpy.mockRestore();
      stdoutSpy.mockRestore();
      if (debug === undefined) delete process.env.LETTA_DEBUG;
      else process.env.LETTA_DEBUG = debug;
      if (debugFile === undefined) delete process.env.LETTA_DEBUG_FILE;
      else process.env.LETTA_DEBUG_FILE = debugFile;
    }
  });
});
