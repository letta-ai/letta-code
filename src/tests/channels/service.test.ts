import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  __testOverrideLoadChannelAccounts,
  __testOverrideSaveChannelAccounts,
  clearChannelAccountStores,
  LEGACY_CHANNEL_ACCOUNT_ID,
} from "../../channels/accounts";
import {
  __testOverrideLoadPairingStore,
  __testOverrideSavePairingStore,
  clearPairingStores,
  createPairingCode,
} from "../../channels/pairing";
import {
  __testOverrideLoadRoutes,
  __testOverrideSaveRoutes,
  clearAllRoutes,
  getRoute,
} from "../../channels/routing";
import {
  __testOverrideResolveChannelAccountDisplayName,
  bindChannelAccountLive,
  bindChannelPairing,
  bindChannelTarget,
  createChannelAccountLive,
  getChannelAccountSnapshot,
  getChannelConfigSnapshot,
  listChannelTargetSnapshots,
  refreshChannelAccountDisplayNameLive,
  removeChannelAccountLive,
  setChannelConfigLive,
  updateChannelAccountLive,
  updateChannelRouteLive,
} from "../../channels/service";
import {
  __testOverrideLoadTargetStore,
  __testOverrideSaveTargetStore,
  clearTargetStores,
  upsertChannelTarget,
} from "../../channels/targets";

describe("channel service", () => {
  function upsertTargetForRouteTest(chatId: string): string {
    const targetId = `target-${chatId}`;
    upsertChannelTarget("slack", {
      targetId,
      targetType: "channel",
      chatId,
      label: `#${chatId.toLowerCase()}`,
      discoveredAt: "2026-04-11T00:00:00.000Z",
      lastSeenAt: "2026-04-11T00:00:00.000Z",
      lastMessageId: "1712790000.000100",
      accountId: "docsbot",
    });
    return targetId;
  }

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

  test("bindChannelTarget rolls back the route and restores the target when route save fails", () => {
    const suffix = randomUUID();
    const targetId = `test-target-bind-rollback-${suffix}`;
    const chatId = `test-chat-bind-rollback-${suffix}`;
    const label = `#test-bind-rollback-${suffix}`;
    const savedTargetSnapshots: Array<
      Array<{ targetId: string; chatId: string; label: string }>
    > = [];

    __testOverrideLoadTargetStore(() => {});
    __testOverrideSaveTargetStore((_channelId, store) => {
      savedTargetSnapshots.push(
        store.targets.map((target) => ({
          targetId: target.targetId,
          chatId: target.chatId,
          label: target.label,
        })),
      );
    });

    upsertChannelTarget("slack", {
      targetId,
      targetType: "channel",
      chatId,
      label,
      discoveredAt: "2026-04-11T00:00:00.000Z",
      lastSeenAt: "2026-04-11T00:00:00.000Z",
      lastMessageId: "1712790000.000100",
    });

    __testOverrideSaveRoutes(() => {
      throw new Error("ENOSPC: no space left");
    });

    expect(() =>
      bindChannelTarget("slack", targetId, "agent-test", "conv-test"),
    ).toThrow(/rolled back/i);

    expect(getRoute("slack", chatId)).toBeNull();
    expect(listChannelTargetSnapshots("slack")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channelId: "slack",
          targetId,
          chatId,
          label,
        }),
      ]),
    );
    expect(savedTargetSnapshots.at(-1)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          targetId,
          chatId,
          label,
        }),
      ]),
    );
  });

  test("channel account lifecycle supports create, update, bind, and remove", async () => {
    const created = createChannelAccountLive(
      "slack",
      {
        displayName: "DocsBot Slack",
        enabled: false,
        botToken: "xoxb-test-token",
        appToken: "xapp-test-token",
        dmPolicy: "pairing",
      },
      { accountId: "docsbot" },
    );

    expect(created).toEqual(
      expect.objectContaining({
        channelId: "slack",
        accountId: "docsbot",
        displayName: "DocsBot Slack",
        configured: true,
        hasBotToken: true,
        hasAppToken: true,
      }),
    );

    const updated = updateChannelAccountLive("slack", "docsbot", {
      displayName: "DocsBot Support",
      enabled: true,
    });
    expect(updated.displayName).toBe("DocsBot Support");
    expect(updated.enabled).toBe(true);

    const bound = bindChannelAccountLive(
      "slack",
      "docsbot",
      "agent-docs",
      "conv-docs",
    );
    expect(bound.channelId).toBe("slack");
    if (bound.channelId !== "slack") {
      throw new Error("Expected Slack account snapshot");
    }
    expect(bound.agentId).toBe("agent-docs");

    expect(getChannelAccountSnapshot("slack", "docsbot")).toEqual(
      expect.objectContaining({
        accountId: "docsbot",
        displayName: "DocsBot Support",
        agentId: "agent-docs",
      }),
    );

    expect(await removeChannelAccountLive("slack", "docsbot")).toBe(true);
    expect(getChannelAccountSnapshot("slack", "docsbot")).toBeNull();
  });

  test("updateChannelRouteLive updates the Slack route without changing the app's default agent", () => {
    createChannelAccountLive(
      "slack",
      {
        displayName: "DocsBot Slack",
        enabled: true,
        botToken: "xoxb-test-token",
        appToken: "xapp-test-token",
        dmPolicy: "pairing",
      },
      { accountId: "docsbot" },
    );

    bindChannelAccountLive("slack", "docsbot", "agent-old", "conv-old");
    bindChannelTarget(
      "slack",
      upsertTargetForRouteTest("C-updatable"),
      "agent-old",
      "conv-old",
      "docsbot",
    );

    const updated = updateChannelRouteLive(
      "slack",
      "C-updatable",
      "agent-new",
      "conv-new",
      "docsbot",
    );

    expect(updated).toEqual(
      expect.objectContaining({
        channelId: "slack",
        accountId: "docsbot",
        chatId: "C-updatable",
        agentId: "agent-new",
        conversationId: "conv-new",
      }),
    );
    expect(getRoute("slack", "C-updatable", "docsbot")).toEqual(
      expect.objectContaining({
        accountId: "docsbot",
        agentId: "agent-new",
        conversationId: "conv-new",
      }),
    );
    expect(getChannelAccountSnapshot("slack", "docsbot")).toEqual(
      expect.objectContaining({
        agentId: "agent-old",
      }),
    );
  });

  test("updateChannelRouteLive leaves the Slack app's default agent unchanged when route save fails", () => {
    createChannelAccountLive(
      "slack",
      {
        enabled: true,
        botToken: "xoxb-test-token",
        appToken: "xapp-test-token",
        dmPolicy: "pairing",
      },
      { accountId: "docsbot" },
    );

    bindChannelAccountLive("slack", "docsbot", "agent-old", "conv-old");
    bindChannelTarget(
      "slack",
      upsertTargetForRouteTest("C-rollback"),
      "agent-old",
      "conv-old",
      "docsbot",
    );

    __testOverrideSaveRoutes(() => {
      throw new Error("ENOSPC: no space left");
    });

    expect(() =>
      updateChannelRouteLive(
        "slack",
        "C-rollback",
        "agent-new",
        "conv-new",
        "docsbot",
      ),
    ).toThrow(/rolled back/i);

    expect(getRoute("slack", "C-rollback", "docsbot")).toEqual(
      expect.objectContaining({
        accountId: "docsbot",
        agentId: "agent-old",
        conversationId: "conv-old",
      }),
    );
    expect(getChannelAccountSnapshot("slack", "docsbot")).toEqual(
      expect.objectContaining({
        agentId: "agent-old",
      }),
    );
  });

  test("loaded generic placeholder account names are scrubbed from snapshots", () => {
    clearChannelAccountStores();
    __testOverrideLoadChannelAccounts(() => [
      {
        channel: "slack",
        accountId: "legacy-slack",
        displayName: "Slack app",
        enabled: false,
        mode: "socket",
        botToken: "xoxb-test-token",
        appToken: "xapp-test-token",
        dmPolicy: "pairing",
        allowedUsers: [],
        agentId: null,
        createdAt: "2026-04-11T00:00:00.000Z",
        updatedAt: "2026-04-11T00:00:00.000Z",
      },
    ]);

    const snapshot = getChannelAccountSnapshot("slack", "legacy-slack");
    expect(snapshot).not.toBeNull();
    expect(snapshot?.displayName).toBeUndefined();
  });

  test("refreshChannelAccountDisplayNameLive hydrates a real platform name", async () => {
    __testOverrideResolveChannelAccountDisplayName(async () => "Letta Code");

    createChannelAccountLive(
      "slack",
      {
        botToken: "xoxb-test-token",
        appToken: "xapp-test-token",
      },
      { accountId: "slack-bot" },
    );

    const refreshed = await refreshChannelAccountDisplayNameLive(
      "slack",
      "slack-bot",
    );

    expect(refreshed.displayName).toBe("Letta Code");
  });

  test("forced display-name refresh clears stale labels when identity lookup returns empty", async () => {
    __testOverrideResolveChannelAccountDisplayName(async () => undefined);

    createChannelAccountLive(
      "slack",
      {
        displayName: "Old Slack Name",
        botToken: "xoxb-test-token",
        appToken: "xapp-test-token",
      },
      { accountId: "slack-bot" },
    );

    const refreshed = await refreshChannelAccountDisplayNameLive(
      "slack",
      "slack-bot",
      { force: true },
    );

    expect(refreshed.displayName).toBeUndefined();
  });

  test("config helpers resolve the sole account instead of assuming a default id", async () => {
    const snapshot = await setChannelConfigLive("telegram", {
      token: "telegram-token",
      dmPolicy: "pairing",
    });

    expect(snapshot.accountId).not.toBe(LEGACY_CHANNEL_ACCOUNT_ID);
    expect(snapshot.accountId).not.toBe("default");
    expect(snapshot.displayName).toBeUndefined();

    expect(getChannelConfigSnapshot("telegram")).toEqual(snapshot);
  });

  test("config helpers reject ambiguous singleton lookups once multiple accounts exist", () => {
    createChannelAccountLive(
      "telegram",
      {
        displayName: "@bot-one",
        token: "token-one",
      },
      { accountId: "bot-one" },
    );
    createChannelAccountLive(
      "telegram",
      {
        displayName: "@bot-two",
        token: "token-two",
      },
      { accountId: "bot-two" },
    );

    expect(() => getChannelConfigSnapshot("telegram")).toThrow(/account_id/i);
  });

  test("pairing bind resolves the account encoded in the pairing code", () => {
    const code = createPairingCode(
      "telegram",
      "user-1",
      "chat-1",
      "john",
      "bot-one",
    );

    const result = bindChannelPairing("telegram", code, "agent-a", "conv-1");
    expect(result.route.accountId).toBe("bot-one");

    const route = getRoute("telegram", "chat-1", "bot-one");
    expect(route).not.toBeNull();
    expect(route?.agentId).toBe("agent-a");
  });
});
