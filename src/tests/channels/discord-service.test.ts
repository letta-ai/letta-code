import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  __testOverrideLoadChannelAccounts,
  __testOverrideSaveChannelAccounts,
  clearChannelAccountStores,
} from "../../channels/accounts";
import {
  __testOverrideLoadPairingStore,
  __testOverrideSavePairingStore,
  clearPairingStores,
} from "../../channels/pairing";
import {
  __testOverrideLoadRoutes,
  __testOverrideSaveRoutes,
  addRoute,
  clearAllRoutes,
  getRoute,
} from "../../channels/routing";
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
} from "../../channels/service";
import {
  __testOverrideLoadTargetStore,
  __testOverrideSaveTargetStore,
  clearTargetStores,
} from "../../channels/targets";

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
    });

    expect(snapshot).not.toBeNull();
    expect(snapshot.channelId).toBe("discord");
    if (snapshot.channelId !== "discord") throw new Error("wrong channel");
    expect(snapshot.hasToken).toBe(true);
    expect(snapshot.dmPolicy).toBe("allowlist");
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
});
