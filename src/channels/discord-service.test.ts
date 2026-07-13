import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  __testOverrideLoadChannelAccounts,
  __testOverrideSaveChannelAccounts,
  clearChannelAccountStores,
  listChannelAccounts,
  loadChannelAccounts,
} from "@/channels/accounts";
import {
  __testOverrideLoadPairingStore,
  __testOverrideSavePairingStore,
  clearPairingStores,
} from "@/channels/pairing";
import {
  __testOverrideLoadRoutes,
  __testOverrideSaveRoutes,
  addRoute,
  clearAllRoutes,
  getRoute,
} from "@/channels/routing";
import {
  __testOverrideResolveChannelAccountDisplayName,
  bindChannelAccountLive,
  createChannelAccountLive,
  getChannelAccountSnapshot,
  getChannelConfigSnapshot,
  listEnabledChannelIds,
  removeChannelRouteLive,
  setChannelConfigLive,
  unbindChannelAccountLive,
  updateChannelAccountLive,
} from "@/channels/service";
import {
  __testOverrideLoadTargetStore,
  __testOverrideSaveTargetStore,
  clearTargetStores,
} from "@/channels/targets";
import { isDiscordChannelAccount } from "@/channels/types";

describe("discord channel service", () => {
  function resetState(): void {
    clearChannelAccountStores();
    clearAllRoutes();
    clearPairingStores();
    clearTargetStores();
    __testOverrideLoadChannelAccounts(null);
    __testOverrideSaveChannelAccounts(null);
    __testOverrideLoadRoutes(null);
    __testOverrideSaveRoutes(null);
    __testOverrideLoadPairingStore(null);
    __testOverrideSavePairingStore(null);
    __testOverrideLoadTargetStore(null);
    __testOverrideSaveTargetStore(null);
    __testOverrideResolveChannelAccountDisplayName(null);
  }

  beforeEach(() => {
    resetState();
    __testOverrideLoadChannelAccounts(() => []);
    __testOverrideSaveChannelAccounts(() => {});
    __testOverrideLoadRoutes(() => null);
    __testOverrideSaveRoutes(() => {});
    __testOverrideLoadPairingStore(() => null);
    __testOverrideSavePairingStore(() => {});
    __testOverrideResolveChannelAccountDisplayName(async () => undefined);
  });

  afterEach(() => {
    resetState();
  });

  test("create / update / bind / unbind lifecycle", () => {
    const created = createChannelAccountLive(
      "discord",
      { token: "test-token", dmPolicy: "pairing" },
      { accountId: "discord-bot" },
    );

    expect(created.channelId).toBe("discord");
    expect(created.configured).toBe(true);
    expect(created.accountId).toBe("discord-bot");

    if (created.channelId !== "discord") throw new Error("wrong channel");
    expect(created.hasToken).toBe(true);
    expect(created.agentId).toBeNull();
    expect(created.defaultPermissionMode).toBe("standard");

    const updated = updateChannelAccountLive("discord", "discord-bot", {
      displayName: "My Bot",
    });
    expect(updated.displayName).toBe("My Bot");

    const bound = bindChannelAccountLive(
      "discord",
      "discord-bot",
      "agent-123",
      "conv-123",
    );
    if (bound.channelId !== "discord") throw new Error("wrong channel");
    expect(bound.agentId).toBe("agent-123");

    const snapshot = getChannelAccountSnapshot("discord", "discord-bot");
    if (!snapshot || snapshot.channelId !== "discord")
      throw new Error("wrong channel");
    expect(snapshot.agentId).toBe("agent-123");
    // Discord uses top-level agentId, not a binding object
    expect((snapshot as Record<string, unknown>).binding).toBeUndefined();

    unbindChannelAccountLive("discord", "discord-bot");
    const unbound = getChannelAccountSnapshot("discord", "discord-bot");
    if (!unbound || unbound.channelId !== "discord")
      throw new Error("wrong channel");
    expect(unbound.agentId).toBeNull();
  });

  test("getChannelConfigSnapshot returns discord-shaped config", () => {
    createChannelAccountLive(
      "discord",
      { token: "test-token", dmPolicy: "pairing" },
      { accountId: "discord-bot" },
    );

    const snapshot = getChannelConfigSnapshot("discord");
    expect(snapshot).not.toBeNull();
    if (!snapshot || snapshot.channelId !== "discord")
      throw new Error("wrong channel");

    expect(snapshot.hasToken).toBe(true);
    expect(snapshot.dmPolicy).toBe("pairing");
    expect(snapshot.defaultPermissionMode).toBe("standard");
    expect(snapshot.autoThreadOnMention).toBe(false);
    expect(snapshot.config.default_permission_mode).toBe("standard");
    expect(snapshot.config.auto_thread_on_mention).toBe(false);

    // Should NOT have Slack-specific fields
    expect((snapshot as Record<string, unknown>).mode).toBeUndefined();
    expect((snapshot as Record<string, unknown>).hasBotToken).toBeUndefined();
  });

  test("listEnabledChannelIds includes enabled discord, excludes disabled telegram", () => {
    createChannelAccountLive(
      "discord",
      { token: "discord-token", dmPolicy: "pairing", enabled: true },
      { accountId: "discord-bot" },
    );

    createChannelAccountLive(
      "telegram",
      { token: "telegram-token", enabled: false },
      { accountId: "telegram-bot" },
    );

    const enabled = listEnabledChannelIds();
    expect(enabled).toContain("discord");
    expect(enabled).not.toContain("telegram");
  });

  test("setChannelConfigLive creates discord account and returns snapshot", async () => {
    const snapshot = await setChannelConfigLive("discord", {
      token: "new-token",
      dmPolicy: "allowlist",
      defaultPermissionMode: "acceptEdits",
      allowedChannels: ["channel-1"],
    });

    expect(snapshot).not.toBeNull();
    expect(snapshot.channelId).toBe("discord");
    if (snapshot.channelId !== "discord") throw new Error("wrong channel");
    expect(snapshot.hasToken).toBe(true);
    expect(snapshot.dmPolicy).toBe("allowlist");
    expect(snapshot.defaultPermissionMode).toBe("acceptEdits");
    expect(snapshot.config.default_permission_mode).toBe("acceptEdits");
    expect(snapshot.allowedChannels).toEqual(["channel-1"]);
  });

  test("discord account snapshots round-trip permission mode and channel allowlist", () => {
    const created = createChannelAccountLive(
      "discord",
      {
        token: "test-token",
        defaultPermissionMode: "acceptEdits",
        allowedChannels: ["channel-1", "channel-2"],
      },
      { accountId: "discord-bot" },
    );

    if (created.channelId !== "discord") throw new Error("wrong channel");
    expect(created.defaultPermissionMode).toBe("acceptEdits");
    expect(created.config.default_permission_mode).toBe("acceptEdits");
    expect(created.allowedChannels).toEqual(["channel-1", "channel-2"]);

    const updated = updateChannelAccountLive("discord", "discord-bot", {
      defaultPermissionMode: "unrestricted",
      allowedChannels: ["channel-3"],
    });

    if (updated.channelId !== "discord") throw new Error("wrong channel");
    expect(updated.defaultPermissionMode).toBe("unrestricted");
    expect(updated.config.default_permission_mode).toBe("unrestricted");
    expect(updated.allowedChannels).toEqual(["channel-3"]);

    const config = getChannelConfigSnapshot("discord", "discord-bot");
    if (!config || config.channelId !== "discord")
      throw new Error("wrong channel");
    expect(config.defaultPermissionMode).toBe("unrestricted");
    expect(config.config.default_permission_mode).toBe("unrestricted");
    expect(config.allowedChannels).toEqual(["channel-3"]);
  });

  test("default dmPolicy is 'pairing' when not specified", () => {
    const created = createChannelAccountLive(
      "discord",
      { token: "test-token" },
      { accountId: "discord-bot" },
    );

    expect(created.channelId).toBe("discord");
    if (created.channelId !== "discord") throw new Error("wrong channel");
    expect(created.dmPolicy).toBe("pairing");
    expect(created.defaultPermissionMode).toBe("standard");
  });

  test("placeholder display names are scrubbed", () => {
    clearChannelAccountStores();
    __testOverrideLoadChannelAccounts(() => [
      {
        channel: "discord",
        accountId: "discord-bot",
        displayName: "Discord bot",
        enabled: false,
        token: "test-token",
        agentId: null,
        defaultPermissionMode: "standard",
        dmPolicy: "pairing",
        allowedUsers: [],
        createdAt: "2026-04-11T00:00:00.000Z",
        updatedAt: "2026-04-11T00:00:00.000Z",
      },
    ]);

    const snapshot = getChannelAccountSnapshot("discord", "discord-bot");
    expect(snapshot).not.toBeNull();
    expect(snapshot?.displayName).toBeUndefined();
  });

  test("bind sets top-level agentId, not a binding object", () => {
    createChannelAccountLive(
      "discord",
      { token: "test-token", dmPolicy: "pairing" },
      { accountId: "discord-bot" },
    );

    const bound = bindChannelAccountLive(
      "discord",
      "discord-bot",
      "agent-456",
      "conv-456",
    );

    if (bound.channelId !== "discord") throw new Error("wrong channel");
    expect(bound.agentId).toBe("agent-456");
    expect((bound as Record<string, unknown>).binding).toBeUndefined();

    const snapshot = getChannelAccountSnapshot("discord", "discord-bot");
    if (!snapshot || snapshot.channelId !== "discord")
      throw new Error("wrong channel");
    expect(snapshot.agentId).toBe("agent-456");
    expect((snapshot as Record<string, unknown>).binding).toBeUndefined();
  });

  test("removeChannelRouteLive removes threaded Discord routes", () => {
    addRoute("discord", {
      accountId: "discord-bot",
      chatId: "thread-1",
      threadId: "thread-1",
      agentId: "agent-1",
      conversationId: "conv-1",
      enabled: true,
      createdAt: "2026-04-11T00:00:00.000Z",
    });

    expect(getRoute("discord", "thread-1", "discord-bot", "thread-1")).not.toBe(
      null,
    );
    expect(removeChannelRouteLive("discord", "thread-1", "discord-bot")).toBe(
      true,
    );
    expect(getRoute("discord", "thread-1", "discord-bot", "thread-1")).toBe(
      null,
    );
  });

  // ── threadPolicyByChannel ──────────────────────────────────

  test("threadPolicyByChannel is set during creation and reflected in snapshot", () => {
    const created = createChannelAccountLive(
      "discord",
      {
        token: "test-token",
        dmPolicy: "pairing",
        threadPolicyByChannel: { "channel-alpha": true, "channel-beta": false },
      },
      { accountId: "discord-bot" },
    );

    if (created.channelId !== "discord") throw new Error("wrong channel");
    expect(created.threadPolicyByChannel).toEqual({
      "channel-alpha": true,
      "channel-beta": false,
    });
    expect(created.config.thread_policy_by_channel).toEqual({
      "channel-alpha": true,
      "channel-beta": false,
    });

    const snapshot = getChannelAccountSnapshot("discord", "discord-bot");
    if (!snapshot || snapshot.channelId !== "discord")
      throw new Error("wrong channel");
    expect(snapshot.threadPolicyByChannel).toEqual({
      "channel-alpha": true,
      "channel-beta": false,
    });
  });

  test("threadPolicyByChannel defaults to empty object when not provided", () => {
    const created = createChannelAccountLive(
      "discord",
      { token: "test-token", dmPolicy: "pairing" },
      { accountId: "discord-bot" },
    );

    if (created.channelId !== "discord") throw new Error("wrong channel");
    // The snapshot normalizes undefined → {}
    expect(created.threadPolicyByChannel).toEqual({});
    expect(created.config.thread_policy_by_channel).toEqual({});
  });

  test("threadPolicyByChannel is preserved through updateChannelAccountLive", () => {
    createChannelAccountLive(
      "discord",
      {
        token: "test-token",
        dmPolicy: "pairing",
        threadPolicyByChannel: { "channel-alpha": true },
      },
      { accountId: "discord-bot" },
    );

    const updated = updateChannelAccountLive("discord", "discord-bot", {
      threadPolicyByChannel: {
        "channel-alpha": false,
        "channel-gamma": true,
      },
    });

    if (updated.channelId !== "discord") throw new Error("wrong channel");
    expect(updated.threadPolicyByChannel).toEqual({
      "channel-alpha": false,
      "channel-gamma": true,
    });
  });

  test("threadPolicyByChannel is preserved through setChannelConfigLive", async () => {
    const snapshot = await setChannelConfigLive("discord", {
      token: "new-token",
      dmPolicy: "pairing",
      threadPolicyByChannel: { "channel-delta": false },
    });

    expect(snapshot).not.toBeNull();
    if (snapshot.channelId !== "discord") throw new Error("wrong channel");
    expect(snapshot.threadPolicyByChannel).toEqual({ "channel-delta": false });
    expect(snapshot.config.thread_policy_by_channel).toEqual({
      "channel-delta": false,
    });
  });

  test("threadPolicyByChannel is merged through patch merge", async () => {
    // Create with no threadPolicyByChannel
    createChannelAccountLive(
      "discord",
      { token: "test-token", dmPolicy: "pairing" },
      { accountId: "discord-bot" },
    );

    // Set config live with threadPolicyByChannel (should update existing)
    const snapshot = await setChannelConfigLive("discord", {
      token: "test-token",
      dmPolicy: "pairing",
      threadPolicyByChannel: { "channel-echo": true },
    });

    expect(snapshot).not.toBeNull();
    if (snapshot.channelId !== "discord") throw new Error("wrong channel");
    expect(snapshot.threadPolicyByChannel).toEqual({ "channel-echo": true });
  });

  // ── Key migration: accounts.json snake_case ↔ camelCase ──────

  test("load: reads snake_case key from loaded account", () => {
    clearChannelAccountStores();
    __testOverrideLoadChannelAccounts(() => [
      {
        channel: "discord",
        accountId: "discord-bot",
        enabled: true,
        token: "test-token",
        agentId: null,
        defaultPermissionMode: "standard",
        dmPolicy: "pairing",
        allowedUsers: [],
        allowed_channels: { "*": "open" },
        thread_policy_by_channel: { "channel-alpha": true },
        createdAt: "2026-04-11T00:00:00.000Z",
        updatedAt: "2026-04-11T00:00:00.000Z",
      },
    ]);
    __testOverrideSaveChannelAccounts(() => {});

    loadChannelAccounts("discord");
    const accounts = listChannelAccounts("discord");
    expect(accounts).toHaveLength(1);
    const first = accounts[0];
    expect(first).toBeDefined();
    if (!first) throw new Error("expected account");
    expect(isDiscordChannelAccount(first)).toBe(true);
    if (!isDiscordChannelAccount(first))
      throw new Error("expected discord account");
    expect(first.allowedChannels).toEqual({ "*": "open" });
    expect(first.threadPolicyByChannel).toEqual({
      "channel-alpha": true,
    });
  });

  test("load: missing auto_thread_on_mention keeps legacy auto-thread behavior", () => {
    clearChannelAccountStores();
    __testOverrideLoadChannelAccounts(() => [
      {
        channel: "discord",
        accountId: "discord-bot",
        enabled: true,
        token: "test-token",
        agentId: null,
        defaultPermissionMode: "standard",
        dmPolicy: "pairing",
        allowedUsers: [],
        createdAt: "2026-04-11T00:00:00.000Z",
        updatedAt: "2026-04-11T00:00:00.000Z",
      },
    ]);
    __testOverrideSaveChannelAccounts(() => {});

    loadChannelAccounts("discord");
    const first = listChannelAccounts("discord")[0];
    expect(first).toBeDefined();
    if (!first || !isDiscordChannelAccount(first)) {
      throw new Error("expected discord account");
    }
    expect(first.autoThreadOnMention).toBe(true);
  });

  test("create: new Discord accounts explicitly default auto-thread off", () => {
    const created = createChannelAccountLive(
      "discord",
      { token: "test-token", dmPolicy: "pairing" },
      { accountId: "discord-bot-defaults" },
    );

    if (created.channelId !== "discord") throw new Error("wrong channel");
    expect(created.autoThreadOnMention).toBe(false);
    expect(created.config.auto_thread_on_mention).toBe(false);

    const account = listChannelAccounts("discord").find(
      (item) => item.accountId === "discord-bot-defaults",
    );
    expect(account).toBeDefined();
    if (!account || !isDiscordChannelAccount(account)) {
      throw new Error("expected discord account");
    }
    expect(account.autoThreadOnMention).toBe(false);
  });

  test("load: reads camelCase key (legacy migration)", () => {
    clearChannelAccountStores();
    __testOverrideLoadChannelAccounts(() => [
      {
        channel: "discord",
        accountId: "discord-bot",
        enabled: true,
        token: "test-token",
        agentId: null,
        defaultPermissionMode: "standard",
        dmPolicy: "pairing",
        allowedUsers: [],
        threadPolicyByChannel: { "channel-beta": false },
        createdAt: "2026-04-11T00:00:00.000Z",
        updatedAt: "2026-04-11T00:00:00.000Z",
      },
    ]);
    __testOverrideSaveChannelAccounts(() => {});

    loadChannelAccounts("discord");
    const accounts = listChannelAccounts("discord");
    expect(accounts).toHaveLength(1);
    const first = accounts[0];
    expect(first).toBeDefined();
    if (!first) throw new Error("expected account");
    expect(isDiscordChannelAccount(first)).toBe(true);
    if (!isDiscordChannelAccount(first))
      throw new Error("expected discord account");
    expect(first.threadPolicyByChannel).toEqual({
      "channel-beta": false,
    });
  });

  test("load: snake_case wins when both keys exist", () => {
    clearChannelAccountStores();
    const warnSpy = mock<(msg: string) => void>();
    const originalWarn = console.warn;
    console.warn = warnSpy;

    try {
      __testOverrideLoadChannelAccounts(() => [
        {
          channel: "discord",
          accountId: "discord-bot",
          enabled: true,
          token: "test-token",
          agentId: null,
          defaultPermissionMode: "standard",
          dmPolicy: "pairing",
          allowedUsers: [],
          thread_policy_by_channel: { "channel-snake": true },
          threadPolicyByChannel: { "channel-camel": false },
          createdAt: "2026-04-11T00:00:00.000Z",
          updatedAt: "2026-04-11T00:00:00.000Z",
        },
      ]);
      __testOverrideSaveChannelAccounts(() => {});

      loadChannelAccounts("discord");
      const accounts = listChannelAccounts("discord");
      expect(accounts).toHaveLength(1);
      const first = accounts[0];
      expect(first).toBeDefined();
      if (!first) throw new Error("expected account");
      expect(isDiscordChannelAccount(first)).toBe(true);
      if (!isDiscordChannelAccount(first))
        throw new Error("expected discord account");
      // snake_case value wins
      expect(first.threadPolicyByChannel).toEqual({
        "channel-snake": true,
      });
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("save: emits snake_case key only", () => {
    clearChannelAccountStores();
    let savedAccounts: unknown[] | null = null;
    __testOverrideLoadChannelAccounts(() => []);
    __testOverrideSaveChannelAccounts((_channelId, accounts) => {
      savedAccounts = accounts;
    });

    createChannelAccountLive(
      "discord",
      {
        token: "test-token",
        dmPolicy: "pairing",
        threadPolicyByChannel: { "channel-gamma": false },
      },
      { accountId: "discord-bot" },
    );

    expect(savedAccounts).not.toBeNull();
    expect(savedAccounts).toHaveLength(1);
    const saved = (
      savedAccounts as unknown as Array<Record<string, unknown>>
    )[0];
    expect(saved).toBeDefined();
    // Should have thread_policy_by_channel (snake_case)
    expect(saved?.thread_policy_by_channel).toEqual({ "channel-gamma": false });
    // Should NOT have threadPolicyByChannel (camelCase)
    expect(saved?.threadPolicyByChannel).toBeUndefined();
  });
});
