import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __testOverrideLoadChannelAccounts,
  __testOverrideSaveChannelAccounts,
  clearChannelAccountStores,
  getChannelAccount,
  LEGACY_CHANNEL_ACCOUNT_ID,
} from "@/channels/accounts";
import { __testOverrideChannelsRoot } from "@/channels/config";
import {
  __testOverrideLoadPairingStore,
  __testOverrideSavePairingStore,
  clearPairingStores,
  createPairingCode,
} from "@/channels/pairing";
import { __testClearUserChannelPluginCache } from "@/channels/plugin-registry";
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
  bindChannelPairing,
  bindChannelTarget,
  createChannelAccountLive,
  getChannelAccountSnapshot,
  getChannelConfigSnapshot,
  listChannelTargetSnapshots,
  listEnabledChannelIds,
  refreshChannelAccountDisplayNameLive,
  removeChannelAccountLive,
  setChannelConfigLive,
  startChannelAccountLive,
  updateChannelAccountLive,
  updateChannelRouteLive,
} from "@/channels/service";
import {
  __testOverrideLoadTargetStore,
  __testOverrideSaveTargetStore,
  clearTargetStores,
  upsertChannelTarget,
} from "@/channels/targets";
import type { SlackChannelAccount } from "@/channels/types";

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

  function writeSchemaSecretChannel(root: string): void {
    const channelDir = join(root, "schemasecret");
    mkdirSync(channelDir, { recursive: true });
    writeFileSync(
      join(channelDir, "channel.json"),
      `${JSON.stringify(
        {
          id: "schemasecret",
          displayName: "Schema Secret",
          entry: "./plugin.mjs",
          configSchema: {
            version: 1,
            fields: [
              { type: "text", key: "endpoint", label: "Endpoint" },
              { type: "secret", key: "api_key", label: "API Key" },
            ],
          },
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(
      join(channelDir, "plugin.mjs"),
      "export const channelPlugin = { metadata: { id: 'schemasecret', displayName: 'Schema Secret' }, createAdapter() { throw new Error('not used'); } };\n",
    );
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
    __testOverrideChannelsRoot(null);
    __testClearUserChannelPluginCache();
  }

  beforeEach(() => {
    resetState();
    __testOverrideLoadChannelAccounts(() => []);
    __testOverrideSaveChannelAccounts(() => {});
    __testOverrideLoadRoutes(() => null);
    __testOverrideSaveRoutes(() => {});
    __testOverrideLoadPairingStore(() => null);
    __testOverrideSavePairingStore(() => {});
    __testOverrideLoadTargetStore(() => {});
    __testOverrideSaveTargetStore(() => {});
    __testOverrideResolveChannelAccountDisplayName(async () => undefined);
  });

  afterEach(() => {
    resetState();
  });

  test("updating a Slack account agent resets existing routes", () => {
    createChannelAccountLive(
      "slack",
      {
        displayName: "DocsBot Slack",
        enabled: true,
        botToken: "xoxb-test-token",
        appToken: "xapp-test-token",
        agentId: "agent-old",
        dmPolicy: "open",
      },
      { accountId: "docsbot" },
    );
    addRoute("slack", {
      accountId: "docsbot",
      chatId: "C-existing",
      chatType: "channel",
      threadId: "1712790000.000100",
      agentId: "agent-old",
      conversationId: "conv-existing",
      enabled: true,
      createdAt: "2026-04-11T00:00:00.000Z",
      updatedAt: "2026-04-11T00:00:00.000Z",
    });

    const updated = updateChannelAccountLive("slack", "docsbot", {
      config: {
        agent_id: "agent-new",
      },
    });

    expect(updated.channelId).toBe("slack");
    if (updated.channelId !== "slack") {
      throw new Error("Expected Slack account snapshot");
    }
    expect(updated.agentId).toBe("agent-new");
    expect(
      getRoute("slack", "C-existing", "docsbot", "1712790000.000100"),
    ).toBeNull();
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
        defaultPermissionMode: "unrestricted",
      }),
    );

    const updated = updateChannelAccountLive("slack", "docsbot", {
      displayName: "DocsBot Support",
      enabled: true,
      defaultPermissionMode: "unrestricted",
    });
    expect(updated.displayName).toBe("DocsBot Support");
    expect(updated.enabled).toBe(true);
    expect(updated.channelId).toBe("slack");
    if (updated.channelId !== "slack") {
      throw new Error("Expected Slack account snapshot");
    }
    expect(updated.defaultPermissionMode).toBe("unrestricted");

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
        defaultPermissionMode: "unrestricted",
      }),
    );

    expect(await removeChannelAccountLive("slack", "docsbot")).toBe(true);
    expect(getChannelAccountSnapshot("slack", "docsbot")).toBeNull();
  });

  test("listEnabledChannelIds returns only channels with enabled accounts", () => {
    createChannelAccountLive(
      "telegram",
      {
        displayName: "Telegram Bot",
        enabled: true,
        token: "telegram-token",
        dmPolicy: "pairing",
      },
      { accountId: "telegram-1" },
    );

    createChannelAccountLive(
      "slack",
      {
        displayName: "Slack App",
        enabled: false,
        botToken: "xoxb-test-token",
        appToken: "xapp-test-token",
        dmPolicy: "pairing",
      },
      { accountId: "slack-1" },
    );

    expect(listEnabledChannelIds()).toEqual(["telegram"]);
  });

  test("listEnabledChannelIds can filter restored accounts by agent scope", () => {
    createChannelAccountLive(
      "telegram",
      {
        displayName: "Local Telegram Bot",
        enabled: true,
        token: "telegram-token",
        dmPolicy: "pairing",
      },
      { accountId: "telegram-local" },
    );
    bindChannelAccountLive(
      "telegram",
      "telegram-local",
      "agent-local-123",
      "conv-local",
    );

    createChannelAccountLive(
      "slack",
      {
        displayName: "Cloud Slack App",
        enabled: true,
        botToken: "xoxb-test-token",
        appToken: "xapp-test-token",
        agentId: "agent-cloud",
        dmPolicy: "pairing",
      },
      { accountId: "slack-cloud" },
    );

    expect(listEnabledChannelIds({ restoreAgentScope: "local" })).toEqual([
      "telegram",
    ]);
    expect(listEnabledChannelIds({ restoreAgentScope: "cloud" })).toEqual([
      "slack",
    ]);
    expect(listEnabledChannelIds({ restoreAgentScope: "all" })).toEqual([
      "telegram",
      "slack",
    ]);
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

  test("updateChannelRouteLive preserves listen-only outbound state", () => {
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
    addRoute("slack", {
      accountId: "docsbot",
      chatId: "C-listen-only",
      chatType: "channel",
      threadId: null,
      agentId: "agent-old",
      conversationId: "conv-old",
      enabled: true,
      outboundEnabled: false,
      createdAt: "2026-04-11T00:00:00.000Z",
      updatedAt: "2026-04-11T00:00:00.000Z",
    });

    const updated = updateChannelRouteLive(
      "slack",
      "C-listen-only",
      "agent-new",
      "conv-new",
      "docsbot",
    );

    expect(updated).toEqual(
      expect.objectContaining({
        channelId: "slack",
        accountId: "docsbot",
        chatId: "C-listen-only",
        agentId: "agent-new",
        conversationId: "conv-new",
        outboundEnabled: false,
      }),
    );
    expect(getRoute("slack", "C-listen-only", "docsbot")).toEqual(
      expect.objectContaining({
        agentId: "agent-new",
        conversationId: "conv-new",
        outboundEnabled: false,
      }),
    );
  });

  test("updateChannelRouteLive creates a Telegram route and binds the account", () => {
    createChannelAccountLive(
      "telegram",
      {
        displayName: "Telegram Bot",
        enabled: false,
        token: "telegram-token",
        dmPolicy: "open",
      },
      { accountId: "telegram-bot" },
    );

    const created = updateChannelRouteLive(
      "telegram",
      "8450770457",
      "agent-telegram",
      "default",
      "telegram-bot",
    );

    expect(created).toEqual(
      expect.objectContaining({
        channelId: "telegram",
        accountId: "telegram-bot",
        chatId: "8450770457",
        agentId: "agent-telegram",
        conversationId: "default",
        enabled: true,
      }),
    );
    expect(getRoute("telegram", "8450770457", "telegram-bot")).toEqual(
      expect.objectContaining({
        accountId: "telegram-bot",
        agentId: "agent-telegram",
        conversationId: "default",
      }),
    );
    expect(getChannelAccountSnapshot("telegram", "telegram-bot")).toEqual(
      expect.objectContaining({
        config: expect.objectContaining({
          binding: {
            agent_id: "agent-telegram",
            conversation_id: "default",
          },
        }),
      }),
    );
  });

  test("updateChannelAccountLive updates Telegram allowlist users", () => {
    createChannelAccountLive(
      "telegram",
      {
        displayName: "Telegram Bot",
        enabled: false,
        token: "telegram-token",
        dmPolicy: "pairing",
      },
      { accountId: "telegram-bot" },
    );

    const updated = updateChannelAccountLive("telegram", "telegram-bot", {
      displayName: "tele test2",
      dmPolicy: "allowlist",
      allowedUsers: ["8450770457"],
    });

    expect(updated).toEqual(
      expect.objectContaining({
        channelId: "telegram",
        accountId: "telegram-bot",
        displayName: "tele test2",
        dmPolicy: "allowlist",
        allowedUsers: ["8450770457"],
      }),
    );
  });

  test("updateChannelAccountLive updates a Telegram token without secret hydration", () => {
    createChannelAccountLive(
      "telegram",
      {
        displayName: "Telegram Bot",
        enabled: false,
        token: "old-token",
        dmPolicy: "pairing",
      },
      { accountId: "telegram-bot" },
    );

    const updated = updateChannelAccountLive("telegram", "telegram-bot", {
      config: { token: "new-token" },
    });

    expect(updated).toEqual(
      expect.objectContaining({
        channelId: "telegram",
        accountId: "telegram-bot",
        config: expect.objectContaining({ has_token: true }),
      }),
    );
  });

  test("createChannelAccountLive rejects enabled accounts with blank required tokens", () => {
    expect(() =>
      createChannelAccountLive(
        "telegram",
        { enabled: true, token: "", dmPolicy: "pairing" },
        { accountId: "telegram-empty" },
      ),
    ).toThrow(/missing a token/i);
    expect(() =>
      createChannelAccountLive(
        "discord",
        { enabled: true, token: "", dmPolicy: "pairing" },
        { accountId: "discord-empty" },
      ),
    ).toThrow(/missing a token/i);
    expect(() =>
      createChannelAccountLive(
        "slack",
        {
          enabled: true,
          botToken: "xoxb-test-token",
          appToken: "",
          dmPolicy: "pairing",
        },
        { accountId: "slack-empty" },
      ),
    ).toThrow(/missing a bot token or app token/i);
  });

  test("existing accounts with blank required tokens cannot be enabled or started", async () => {
    createChannelAccountLive(
      "telegram",
      { enabled: false, token: "", dmPolicy: "pairing" },
      { accountId: "telegram-empty" },
    );
    createChannelAccountLive(
      "discord",
      { enabled: false, token: "", dmPolicy: "pairing" },
      { accountId: "discord-empty" },
    );
    createChannelAccountLive(
      "slack",
      {
        enabled: false,
        botToken: "",
        appToken: "",
        dmPolicy: "pairing",
      },
      { accountId: "slack-empty" },
    );

    expect(() =>
      updateChannelAccountLive("telegram", "telegram-empty", {
        enabled: true,
      }),
    ).toThrow(/missing a token/i);
    expect(() =>
      updateChannelAccountLive("discord", "discord-empty", {
        enabled: true,
      }),
    ).toThrow(/missing a token/i);
    expect(() =>
      updateChannelAccountLive("slack", "slack-empty", {
        enabled: true,
      }),
    ).toThrow(/missing a bot token or app token/i);

    expect(getChannelAccount("telegram", "telegram-empty")).toEqual(
      expect.objectContaining({ enabled: false, token: "" }),
    );
    expect(getChannelAccount("discord", "discord-empty")).toEqual(
      expect.objectContaining({ enabled: false, token: "" }),
    );
    expect(getChannelAccount("slack", "slack-empty")).toEqual(
      expect.objectContaining({
        enabled: false,
        botToken: "",
        appToken: "",
      }),
    );

    await expect(
      startChannelAccountLive("telegram", "telegram-empty"),
    ).rejects.toThrow(/missing a token/i);
    await expect(
      startChannelAccountLive("discord", "discord-empty"),
    ).rejects.toThrow(/missing a token/i);
    await expect(
      startChannelAccountLive("slack", "slack-empty"),
    ).rejects.toThrow(/missing a bot token or app token/i);
  });

  test("blank channel config secrets preserve existing credentials", async () => {
    createChannelAccountLive(
      "telegram",
      {
        displayName: "Telegram Bot",
        enabled: false,
        token: "telegram-old-token",
        dmPolicy: "pairing",
      },
      { accountId: "telegram-bot" },
    );
    createChannelAccountLive(
      "discord",
      {
        displayName: "Discord Bot",
        enabled: false,
        token: "discord-old-token",
        dmPolicy: "pairing",
      },
      { accountId: "discord-bot" },
    );
    createChannelAccountLive(
      "slack",
      {
        displayName: "Slack Bot",
        enabled: false,
        botToken: "xoxb-old-token",
        appToken: "xapp-old-token",
        dmPolicy: "pairing",
      },
      { accountId: "slack-bot" },
    );

    await setChannelConfigLive(
      "telegram",
      { config: { token: "" } },
      "telegram-bot",
    );
    await setChannelConfigLive(
      "discord",
      { config: { token: "" } },
      "discord-bot",
    );
    await setChannelConfigLive(
      "slack",
      { config: { bot_token: "", app_token: "" } },
      "slack-bot",
    );
    updateChannelAccountLive("telegram", "telegram-bot", { token: "" });
    updateChannelAccountLive("discord", "discord-bot", { token: "" });
    updateChannelAccountLive("slack", "slack-bot", {
      botToken: "",
      appToken: "",
    });

    expect(getChannelAccount("telegram", "telegram-bot")).toEqual(
      expect.objectContaining({ token: "telegram-old-token" }),
    );
    expect(getChannelAccount("discord", "discord-bot")).toEqual(
      expect.objectContaining({ token: "discord-old-token" }),
    );
    expect(getChannelAccount("slack", "slack-bot")).toEqual(
      expect.objectContaining({
        botToken: "xoxb-old-token",
        appToken: "xapp-old-token",
      }),
    );
  });

  test("partial Slack token updates preserve the omitted token", () => {
    createChannelAccountLive(
      "slack",
      {
        displayName: "Slack Bot",
        enabled: false,
        botToken: "xoxb-old-token",
        appToken: "xapp-old-token",
        dmPolicy: "pairing",
      },
      { accountId: "slack-bot" },
    );

    updateChannelAccountLive("slack", "slack-bot", {
      botToken: "xoxb-new-token",
    });
    expect(getChannelAccount("slack", "slack-bot")).toEqual(
      expect.objectContaining({
        botToken: "xoxb-new-token",
        appToken: "xapp-old-token",
      }),
    );

    updateChannelAccountLive("slack", "slack-bot", {
      config: { app_token: "xapp-new-token" },
    });
    expect(getChannelAccount("slack", "slack-bot")).toEqual(
      expect.objectContaining({
        botToken: "xoxb-new-token",
        appToken: "xapp-new-token",
      }),
    );
  });

  test("custom channel blank secret config patches preserve existing values", async () => {
    createChannelAccountLive(
      "custom",
      {
        enabled: false,
        dmPolicy: "pairing",
        config: {
          url: "https://old.example.test/webhook",
          bot_token: "custom-old-bot-token",
          auth: "custom-old-auth-token",
        },
      },
      { accountId: "custom-bot" },
    );

    await setChannelConfigLive(
      "custom",
      {
        config: {
          url: "https://new.example.test/webhook",
          bot_token: "",
          auth: "",
        },
      },
      "custom-bot",
    );
    expect(getChannelAccount("custom", "custom-bot")).toEqual(
      expect.objectContaining({
        config: expect.objectContaining({
          url: "https://new.example.test/webhook",
          bot_token: "custom-old-bot-token",
          auth: "custom-old-auth-token",
        }),
      }),
    );

    await setChannelConfigLive(
      "custom",
      { config: { bot_token: "custom-new-bot-token" } },
      "custom-bot",
    );
    expect(getChannelAccount("custom", "custom-bot")).toEqual(
      expect.objectContaining({
        config: expect.objectContaining({
          bot_token: "custom-new-bot-token",
          auth: "custom-old-auth-token",
        }),
      }),
    );

    await setChannelConfigLive(
      "custom",
      { config: { auth: null } },
      "custom-bot",
    );
    expect(getChannelAccount("custom", "custom-bot")).toEqual(
      expect.objectContaining({
        config: expect.objectContaining({
          bot_token: "custom-new-bot-token",
          auth: null,
        }),
      }),
    );
  });

  test("schema-declared plugin secret blank saves preserve existing config credentials", async () => {
    const channelsRoot = mkdtempSync(join(tmpdir(), "letta-channel-service-"));
    try {
      __testOverrideChannelsRoot(channelsRoot);
      __testClearUserChannelPluginCache();
      writeSchemaSecretChannel(channelsRoot);

      createChannelAccountLive(
        "schemasecret",
        {
          enabled: false,
          dmPolicy: "pairing",
          config: {
            endpoint: "https://old.example.test/webhook",
            api_key: "plugin-old-api-key",
          },
        },
        { accountId: "schema-account" },
      );

      await setChannelConfigLive(
        "schemasecret",
        {
          config: {
            endpoint: "https://new.example.test/webhook",
            api_key: "",
          },
        },
        "schema-account",
      );
      expect(getChannelAccount("schemasecret", "schema-account")).toEqual(
        expect.objectContaining({
          config: expect.objectContaining({
            endpoint: "https://new.example.test/webhook",
            api_key: "plugin-old-api-key",
          }),
        }),
      );

      await setChannelConfigLive(
        "schemasecret",
        { config: { api_key: "plugin-new-api-key" } },
        "schema-account",
      );
      expect(getChannelAccount("schemasecret", "schema-account")).toEqual(
        expect.objectContaining({
          config: expect.objectContaining({
            api_key: "plugin-new-api-key",
          }),
        }),
      );
    } finally {
      __testOverrideChannelsRoot(null);
      __testClearUserChannelPluginCache();
      rmSync(channelsRoot, { recursive: true, force: true });
    }
  });

  test("non-empty channel config secrets replace existing credentials", () => {
    createChannelAccountLive(
      "telegram",
      {
        displayName: "Telegram Bot",
        enabled: false,
        token: "telegram-old-token",
        dmPolicy: "pairing",
      },
      { accountId: "telegram-bot" },
    );
    createChannelAccountLive(
      "discord",
      {
        displayName: "Discord Bot",
        enabled: false,
        token: "discord-old-token",
        dmPolicy: "pairing",
      },
      { accountId: "discord-bot" },
    );
    createChannelAccountLive(
      "slack",
      {
        displayName: "Slack Bot",
        enabled: false,
        botToken: "xoxb-old-token",
        appToken: "xapp-old-token",
        dmPolicy: "pairing",
      },
      { accountId: "slack-bot" },
    );

    updateChannelAccountLive("telegram", "telegram-bot", {
      config: { token: "telegram-new-token" },
    });
    updateChannelAccountLive("discord", "discord-bot", {
      config: { token: "discord-new-token" },
    });
    updateChannelAccountLive("slack", "slack-bot", {
      config: {
        bot_token: "xoxb-new-token",
        app_token: "xapp-new-token",
      },
    });

    expect(getChannelAccount("telegram", "telegram-bot")).toEqual(
      expect.objectContaining({ token: "telegram-new-token" }),
    );
    expect(getChannelAccount("discord", "discord-bot")).toEqual(
      expect.objectContaining({ token: "discord-new-token" }),
    );
    expect(getChannelAccount("slack", "slack-bot")).toEqual(
      expect.objectContaining({
        botToken: "xoxb-new-token",
        appToken: "xapp-new-token",
      }),
    );
  });

  test("createChannelAccountLive creates a Telegram allowlist account without secret hydration", () => {
    const created = createChannelAccountLive(
      "telegram",
      {
        displayName: "Telegram Bot",
        enabled: false,
        token: "telegram-token",
        dmPolicy: "allowlist",
        allowedUsers: ["8450770457"],
      },
      { accountId: "telegram-bot" },
    );

    expect(created).toEqual(
      expect.objectContaining({
        channelId: "telegram",
        accountId: "telegram-bot",
        displayName: "Telegram Bot",
        dmPolicy: "allowlist",
        allowedUsers: ["8450770457"],
      }),
    );
  });

  test("removeChannelAccountLive deletes a Telegram account without secret hydration", async () => {
    createChannelAccountLive(
      "telegram",
      {
        displayName: "Telegram Bot",
        enabled: false,
        token: "telegram-token",
        dmPolicy: "pairing",
      },
      { accountId: "telegram-bot" },
    );

    expect(await removeChannelAccountLive("telegram", "telegram-bot")).toBe(
      true,
    );
    expect(getChannelAccountSnapshot("telegram", "telegram-bot")).toBeNull();
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
        defaultPermissionMode: "standard",
        createdAt: "2026-04-11T00:00:00.000Z",
        updatedAt: "2026-04-11T00:00:00.000Z",
      },
    ]);

    const snapshot = getChannelAccountSnapshot("slack", "legacy-slack");
    expect(snapshot).not.toBeNull();
    expect(snapshot?.displayName).toBeUndefined();
    expect(snapshot?.channelId).toBe("slack");
    if (snapshot?.channelId === "slack") {
      expect(snapshot.defaultPermissionMode).toBe("standard");
    }
  });

  test("Slack accounts without persisted permission mode default to unrestricted", () => {
    clearChannelAccountStores();
    __testOverrideLoadChannelAccounts(() => [
      {
        channel: "slack",
        accountId: "legacy-slack",
        enabled: false,
        mode: "socket",
        botToken: "xoxb-test-token",
        appToken: "xapp-test-token",
        dmPolicy: "pairing",
        allowedUsers: [],
        agentId: null,
        createdAt: "2026-04-11T00:00:00.000Z",
        updatedAt: "2026-04-11T00:00:00.000Z",
      } as unknown as SlackChannelAccount,
    ]);

    const snapshot = getChannelAccountSnapshot("slack", "legacy-slack");
    expect(snapshot?.channelId).toBe("slack");
    if (snapshot?.channelId === "slack") {
      expect(snapshot.defaultPermissionMode).toBe("unrestricted");
    }
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

  test("forced display-name refresh preserves user-provided labels", async () => {
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

    expect(refreshed.displayName).toBe("Old Slack Name");
  });

  test("config helpers resolve the sole account instead of assuming a default id", async () => {
    const snapshot = await setChannelConfigLive("telegram", {
      token: "telegram-token",
      dmPolicy: "pairing",
    });

    expect(snapshot.accountId).not.toBe(LEGACY_CHANNEL_ACCOUNT_ID);
    expect(snapshot.accountId).not.toBe("standard");
    expect(snapshot.displayName).toBeUndefined();

    expect(getChannelConfigSnapshot("telegram")).toEqual(snapshot);
  });

  test("telegram account snapshots fall back to persisted routes when binding metadata is stale", () => {
    createChannelAccountLive(
      "telegram",
      {
        displayName: "@boty_mc_lcd_bot",
        enabled: true,
        token: "telegram-token",
        dmPolicy: "pairing",
        transcribeVoice: true,
      },
      { accountId: "bot-one" },
    );

    bindChannelPairing(
      "telegram",
      createPairingCode("telegram", "sender-1", "chat-1", "C P", "bot-one"),
      "agent-telegram",
      "conv-telegram",
    );

    updateChannelAccountLive("telegram", "bot-one", {
      token: "telegram-token",
      enabled: true,
      dmPolicy: "pairing",
      transcribeVoice: true,
    });

    expect(getChannelAccountSnapshot("telegram", "bot-one")).toEqual(
      expect.objectContaining({
        accountId: "bot-one",
        transcribeVoice: true,
        binding: {
          agentId: "agent-telegram",
          conversationId: "conv-telegram",
        },
        config: expect.objectContaining({
          binding: {
            agent_id: "agent-telegram",
            conversation_id: "conv-telegram",
          },
        }),
      }),
    );
  });

  test("telegram live account helpers preserve Telegram boolean settings", () => {
    const created = createChannelAccountLive(
      "telegram",
      {
        displayName: "@voice-bot",
        enabled: true,
        token: "telegram-token",
        dmPolicy: "pairing",
        transcribeVoice: true,
        richPrivateChatDefault: false,
      },
      { accountId: "voice-bot" },
    );

    expect(created).toEqual(
      expect.objectContaining({
        accountId: "voice-bot",
        transcribeVoice: true,
        richPrivateChatDefault: false,
        config: expect.objectContaining({
          rich_private_chat_default: false,
        }),
      }),
    );

    const updated = updateChannelAccountLive("telegram", "voice-bot", {
      transcribeVoice: false,
      richPrivateChatDefault: true,
    });

    expect(updated).toEqual(
      expect.objectContaining({
        accountId: "voice-bot",
        transcribeVoice: false,
        richPrivateChatDefault: true,
        config: expect.objectContaining({
          rich_private_chat_default: true,
        }),
      }),
    );

    expect(getChannelAccountSnapshot("telegram", "voice-bot")).toEqual(
      expect.objectContaining({
        accountId: "voice-bot",
        transcribeVoice: false,
        richPrivateChatDefault: true,
        config: expect.objectContaining({
          rich_private_chat_default: true,
        }),
      }),
    );
  });

  test("slack live account helpers preserve the transcribeVoice opt-in in snapshots", () => {
    const created = createChannelAccountLive(
      "slack",
      {
        displayName: "Slack Voice",
        enabled: true,
        dmPolicy: "pairing",
        config: {
          bot_token: "xoxb-test-token",
          app_token: "xapp-test-token",
          mode: "socket",
          agent_id: null,
          transcribe_voice: true,
          listen_mode: true,
        },
      },
      { accountId: "slack-voice" },
    );

    expect(created).toEqual(
      expect.objectContaining({
        accountId: "slack-voice",
        transcribeVoice: true,
        config: expect.objectContaining({
          transcribe_voice: true,
          listen_mode: true,
        }),
      }),
    );

    const updated = updateChannelAccountLive("slack", "slack-voice", {
      config: {
        transcribe_voice: false,
        listen_mode: false,
      },
    });

    expect(updated).toEqual(
      expect.objectContaining({
        accountId: "slack-voice",
        transcribeVoice: false,
        config: expect.objectContaining({
          transcribe_voice: false,
          listen_mode: false,
        }),
      }),
    );

    expect(getChannelConfigSnapshot("slack", "slack-voice")).toEqual(
      expect.objectContaining({
        accountId: "slack-voice",
        transcribeVoice: false,
        config: expect.objectContaining({
          transcribe_voice: false,
          listen_mode: false,
        }),
      }),
    );
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
