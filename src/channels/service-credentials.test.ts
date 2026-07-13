import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __testOverrideLoadChannelAccounts,
  __testOverrideSaveChannelAccounts,
  clearChannelAccountStores,
  getChannelAccount,
} from "@/channels/accounts";
import { __testOverrideChannelsRoot } from "@/channels/config";
import { __setActiveChannelCredentialsStoreModeForTests } from "@/channels/credential-store";
import {
  __testOverrideLoadPairingStore,
  __testOverrideSavePairingStore,
  clearPairingStores,
} from "@/channels/pairing";
import { __testClearUserChannelPluginCache } from "@/channels/plugin-registry";
import {
  __testOverrideLoadRoutes,
  __testOverrideSaveRoutes,
  clearAllRoutes,
} from "@/channels/routing";
import {
  createChannelAccountLive,
  getChannelAccountSnapshot,
  getChannelConfigSnapshot,
  removeChannelAccountLive,
  setChannelConfigLive,
  startChannelAccountLive,
  updateChannelAccountLive,
} from "@/channels/service";
import {
  __testOverrideLoadTargetStore,
  __testOverrideSaveTargetStore,
  clearTargetStores,
} from "@/channels/targets";

describe("channel service credential handling", () => {
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
    __setActiveChannelCredentialsStoreModeForTests(null);
    __testOverrideChannelsRoot(null);
    __testClearUserChannelPluginCache();
  }

  beforeEach(() => {
    resetState();
    __setActiveChannelCredentialsStoreModeForTests("file");
    __testOverrideLoadChannelAccounts(() => []);
    __testOverrideSaveChannelAccounts(() => {});
    __testOverrideLoadRoutes(() => null);
    __testOverrideSaveRoutes(() => {});
    __testOverrideLoadPairingStore(() => null);
    __testOverrideSavePairingStore(() => {});
    __testOverrideLoadTargetStore(() => {});
    __testOverrideSaveTargetStore(() => {});
  });

  afterEach(() => {
    resetState();
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

      const created = createChannelAccountLive(
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
      expect(created.config).toMatchObject({
        endpoint: "https://old.example.test/webhook",
        has_api_key: true,
        configured: true,
      });
      expect(JSON.stringify(created.config)).not.toContain(
        "plugin-old-api-key",
      );
      expect(
        getChannelAccountSnapshot("schemasecret", "schema-account"),
      ).toEqual(
        expect.objectContaining({
          config: expect.objectContaining({
            endpoint: "https://old.example.test/webhook",
            has_api_key: true,
          }),
        }),
      );
      expect(
        getChannelConfigSnapshot("schemasecret", "schema-account"),
      ).toEqual(
        expect.objectContaining({
          config: expect.objectContaining({
            endpoint: "https://old.example.test/webhook",
            has_api_key: true,
          }),
        }),
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
});
