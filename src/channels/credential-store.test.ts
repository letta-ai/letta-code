import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearChannelAccountStores,
  flushPendingChannelSecretWrites,
  getChannelAccountWithSecrets,
  hydrateChannelAccountSecrets,
  removeChannelAccountWithSecrets,
  upsertChannelAccountWithSecrets,
} from "@/channels/accounts";
import { __testOverrideChannelsRoot } from "@/channels/config";
import {
  __setActiveChannelCredentialsStoreModeForTests,
  __setChannelCredentialsStoreModeForTests,
  __setChannelKeychainAvailableForTests,
  __setChannelSecretStoreOverrideForTests,
  buildChannelSecretName,
  getActiveChannelCredentialsStoreMode,
} from "@/channels/credential-store";
import { __testClearUserChannelPluginCache } from "@/channels/plugin-registry";
import { getChannelRegistry, initializeChannels } from "@/channels/registry";
import {
  createChannelAccountLiveWithSecrets,
  removeChannelAccountLive,
} from "@/channels/service";
import type {
  CustomChannelAccount,
  SlackChannelAccount,
  TelegramChannelAccount,
} from "@/channels/types";

function readAccountsFile(root: string, channelId: string): unknown {
  return JSON.parse(
    readFileSync(join(root, channelId, "accounts.json"), "utf-8"),
  );
}

function makeSlackAccount(): SlackChannelAccount {
  return {
    channel: "slack",
    accountId: "slack-account",
    enabled: true,
    mode: "socket",
    botToken: "xoxb-secret",
    appToken: "xapp-secret",
    agentId: "agent-1",
    defaultPermissionMode: "acceptEdits",
    dmPolicy: "pairing",
    allowedUsers: [],
    createdAt: "2026-05-26T00:00:00.000Z",
    updatedAt: "2026-05-26T00:00:00.000Z",
  };
}

function makeTelegramAccount(): TelegramChannelAccount {
  return {
    channel: "telegram",
    accountId: "telegram-account",
    enabled: true,
    token: "telegram-secret",
    displayName: "Telegram Bot",
    dmPolicy: "pairing",
    allowedUsers: [],
    binding: {
      agentId: null,
      conversationId: null,
    },
    createdAt: "2026-05-26T00:00:00.000Z",
    updatedAt: "2026-05-26T00:00:00.000Z",
  };
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

function makeSchemaSecretAccount(): CustomChannelAccount {
  return {
    channel: "schemasecret",
    accountId: "schema-account",
    enabled: true,
    dmPolicy: "pairing",
    allowedUsers: [],
    config: {
      endpoint: "https://example.test/webhook",
      api_key: "schema-secret",
    },
    createdAt: "2026-05-26T00:00:00.000Z",
    updatedAt: "2026-05-26T00:00:00.000Z",
  };
}

describe("channel credential storage", () => {
  let channelsRoot: string;
  let secrets: Map<string, string>;

  beforeEach(() => {
    channelsRoot = mkdtempSync(join(tmpdir(), "letta-channel-secrets-"));
    secrets = new Map<string, string>();
    clearChannelAccountStores();
    __testOverrideChannelsRoot(channelsRoot);
    __testClearUserChannelPluginCache();
    __setChannelCredentialsStoreModeForTests(null);
    __setActiveChannelCredentialsStoreModeForTests(null);
    __setChannelKeychainAvailableForTests(null);
    __setChannelSecretStoreOverrideForTests({
      get: async (name) => secrets.get(name) ?? null,
      set: async (name, value) => {
        secrets.set(name, value);
      },
      delete: async (name) => secrets.delete(name),
    });
  });

  afterEach(() => {
    clearChannelAccountStores();
    __testOverrideChannelsRoot(null);
    __testClearUserChannelPluginCache();
    __setChannelCredentialsStoreModeForTests(null);
    __setActiveChannelCredentialsStoreModeForTests(null);
    __setChannelKeychainAvailableForTests(null);
    __setChannelSecretStoreOverrideForTests(null);
    rmSync(channelsRoot, { recursive: true, force: true });
  });

  test("keyring mode stores Slack tokens outside accounts.json and hydrates them", async () => {
    __setActiveChannelCredentialsStoreModeForTests("keyring");

    await upsertChannelAccountWithSecrets("slack", makeSlackAccount());
    await flushPendingChannelSecretWrites();

    expect(
      secrets.get(buildChannelSecretName("slack", "slack-account", "botToken")),
    ).toBe("xoxb-secret");
    expect(
      secrets.get(buildChannelSecretName("slack", "slack-account", "appToken")),
    ).toBe("xapp-secret");

    const persisted = readAccountsFile(channelsRoot, "slack") as {
      accounts: Array<Record<string, unknown>>;
    };
    expect(JSON.stringify(persisted)).not.toContain("xoxb-secret");
    expect(JSON.stringify(persisted)).not.toContain("xapp-secret");
    expect(persisted.accounts[0]).toMatchObject({
      __letta_secret_refs: {
        botToken: true,
        appToken: true,
      },
    });

    clearChannelAccountStores();
    const hydrated = (await getChannelAccountWithSecrets(
      "slack",
      "slack-account",
    )) as SlackChannelAccount | null;

    expect(hydrated?.botToken).toBe("xoxb-secret");
    expect(hydrated?.appToken).toBe("xapp-secret");
  });

  test("keyring mode migrates existing plaintext tokens out of accounts.json", async () => {
    __setActiveChannelCredentialsStoreModeForTests("keyring");
    mkdirSync(join(channelsRoot, "slack"), { recursive: true });
    writeFileSync(
      join(channelsRoot, "slack", "accounts.json"),
      `${JSON.stringify({ accounts: [makeSlackAccount()] }, null, 2)}\n`,
    );

    await hydrateChannelAccountSecrets("slack");

    expect(
      secrets.get(buildChannelSecretName("slack", "slack-account", "botToken")),
    ).toBe("xoxb-secret");
    expect(
      secrets.get(buildChannelSecretName("slack", "slack-account", "appToken")),
    ).toBe("xapp-secret");

    const persistedText = readFileSync(
      join(channelsRoot, "slack", "accounts.json"),
      "utf-8",
    );
    expect(persistedText).not.toContain("xoxb-secret");
    expect(persistedText).not.toContain("xapp-secret");
    expect(persistedText).toContain("__letta_secret_refs");
  });

  test("missing keyring refs preserve Telegram refs instead of writing an empty token", async () => {
    __setActiveChannelCredentialsStoreModeForTests("keyring");
    mkdirSync(join(channelsRoot, "telegram"), { recursive: true });
    await upsertChannelAccountWithSecrets("telegram", makeTelegramAccount());
    await flushPendingChannelSecretWrites();
    secrets.clear();
    clearChannelAccountStores();

    const beforeText = readFileSync(
      join(channelsRoot, "telegram", "accounts.json"),
      "utf-8",
    );

    await expect(hydrateChannelAccountSecrets("telegram")).rejects.toThrow(
      /saved secret reference was preserved/i,
    );

    const afterText = readFileSync(
      join(channelsRoot, "telegram", "accounts.json"),
      "utf-8",
    );
    expect(afterText).toBe(beforeText);
    const persisted = JSON.parse(afterText) as {
      accounts: Array<Record<string, unknown>>;
    };
    expect(persisted.accounts[0]).toMatchObject({
      __letta_secret_refs: {
        token: true,
      },
    });
    expect(persisted.accounts[0]).not.toHaveProperty("token", "");
  });

  test("missing keyring refs preserve both Slack refs instead of writing empty tokens", async () => {
    __setActiveChannelCredentialsStoreModeForTests("keyring");
    await upsertChannelAccountWithSecrets("slack", makeSlackAccount());
    await flushPendingChannelSecretWrites();
    secrets.clear();
    clearChannelAccountStores();

    const beforeText = readFileSync(
      join(channelsRoot, "slack", "accounts.json"),
      "utf-8",
    );

    await expect(hydrateChannelAccountSecrets("slack")).rejects.toThrow(
      /saved secret reference was preserved/i,
    );

    const afterText = readFileSync(
      join(channelsRoot, "slack", "accounts.json"),
      "utf-8",
    );
    expect(afterText).toBe(beforeText);
    const persisted = JSON.parse(afterText) as {
      accounts: Array<Record<string, unknown>>;
    };
    expect(persisted.accounts[0]).toMatchObject({
      __letta_secret_refs: {
        botToken: true,
        appToken: true,
      },
    });
    expect(persisted.accounts[0]).not.toHaveProperty("bot_token", "");
    expect(persisted.accounts[0]).not.toHaveProperty("app_token", "");
  });

  test("deleting an account removes keyring secrets", async () => {
    __setActiveChannelCredentialsStoreModeForTests("keyring");

    await upsertChannelAccountWithSecrets("slack", makeSlackAccount());
    await flushPendingChannelSecretWrites();

    expect(
      await removeChannelAccountWithSecrets("slack", "slack-account"),
    ).toBe(true);
    expect(
      secrets.has(buildChannelSecretName("slack", "slack-account", "botToken")),
    ).toBe(false);
    expect(
      secrets.has(buildChannelSecretName("slack", "slack-account", "appToken")),
    ).toBe(false);
  });

  test("live account delete removes keyring secrets", async () => {
    __setActiveChannelCredentialsStoreModeForTests("keyring");

    await createChannelAccountLiveWithSecrets(
      "telegram",
      {
        enabled: false,
        token: "telegram-secret",
        dmPolicy: "pairing",
      },
      { accountId: "telegram-live" },
    );
    await flushPendingChannelSecretWrites();

    expect(
      secrets.get(buildChannelSecretName("telegram", "telegram-live", "token")),
    ).toBe("telegram-secret");

    await expect(
      removeChannelAccountLive("telegram", "telegram-live"),
    ).resolves.toBe(true);
    expect(
      secrets.has(buildChannelSecretName("telegram", "telegram-live", "token")),
    ).toBe(false);
  });

  test("keyring mode stores schema-declared plugin secrets outside accounts.json and hydrates them", async () => {
    writeSchemaSecretChannel(channelsRoot);
    __setActiveChannelCredentialsStoreModeForTests("keyring");

    await upsertChannelAccountWithSecrets(
      "schemasecret",
      makeSchemaSecretAccount(),
    );
    await flushPendingChannelSecretWrites();

    expect(
      secrets.get(
        buildChannelSecretName(
          "schemasecret",
          "schema-account",
          "config.api_key",
        ),
      ),
    ).toBe("schema-secret");

    const persisted = readAccountsFile(channelsRoot, "schemasecret") as {
      accounts: Array<Record<string, unknown>>;
    };
    expect(JSON.stringify(persisted)).not.toContain("schema-secret");
    expect(persisted.accounts[0]).toMatchObject({
      config: {
        endpoint: "https://example.test/webhook",
      },
      __letta_secret_refs: {
        "config.api_key": true,
      },
    });

    clearChannelAccountStores();
    const hydrated = (await getChannelAccountWithSecrets(
      "schemasecret",
      "schema-account",
    )) as CustomChannelAccount | null;

    expect(hydrated?.config).toEqual(
      expect.objectContaining({
        endpoint: "https://example.test/webhook",
        api_key: "schema-secret",
      }),
    );

    expect(
      await removeChannelAccountWithSecrets("schemasecret", "schema-account"),
    ).toBe(true);
    expect(
      secrets.has(
        buildChannelSecretName(
          "schemasecret",
          "schema-account",
          "config.api_key",
        ),
      ),
    ).toBe(false);
  });

  test("scoped hydration ignores missing refs on unrelated accounts", async () => {
    writeSchemaSecretChannel(channelsRoot);
    __setActiveChannelCredentialsStoreModeForTests("keyring");

    await upsertChannelAccountWithSecrets("schemasecret", {
      ...makeSchemaSecretAccount(),
      accountId: "schema-good",
      config: {
        endpoint: "https://good.example.test/webhook",
        api_key: "good-secret",
      },
    });
    await upsertChannelAccountWithSecrets("schemasecret", {
      ...makeSchemaSecretAccount(),
      accountId: "schema-broken",
      config: {
        endpoint: "https://broken.example.test/webhook",
        api_key: "broken-secret",
      },
    });
    await flushPendingChannelSecretWrites();
    secrets.delete(
      buildChannelSecretName("schemasecret", "schema-broken", "config.api_key"),
    );
    clearChannelAccountStores();

    const hydrated = (await getChannelAccountWithSecrets(
      "schemasecret",
      "schema-good",
    )) as CustomChannelAccount | null;
    expect(hydrated?.config).toMatchObject({
      endpoint: "https://good.example.test/webhook",
      api_key: "good-secret",
    });

    await expect(
      getChannelAccountWithSecrets("schemasecret", "schema-broken"),
    ).rejects.toThrow(/saved secret reference was preserved/i);
  });

  test("startup does not hydrate unrelated channel credential refs", async () => {
    __setActiveChannelCredentialsStoreModeForTests("keyring");
    mkdirSync(join(channelsRoot, "telegram"), { recursive: true });
    writeFileSync(
      join(channelsRoot, "telegram", "accounts.json"),
      `${JSON.stringify(
        {
          accounts: [
            {
              channel: "telegram",
              accountId: "broken-telegram",
              enabled: true,
              token: "__letta_channel_secret_present__",
              dmPolicy: "pairing",
              allowedUsers: [],
              binding: { agentId: null, conversationId: null },
              __letta_secret_refs: { token: true },
              createdAt: "2026-05-26T00:00:00.000Z",
              updatedAt: "2026-05-26T00:00:00.000Z",
            },
          ],
        },
        null,
        2,
      )}\n`,
    );

    try {
      await expect(initializeChannels(["slack"])).resolves.toBeTruthy();
    } finally {
      await getChannelRegistry()?.stopAll();
    }
  });

  test("missing keyring refs preserve schema-declared plugin refs instead of writing blank config", async () => {
    writeSchemaSecretChannel(channelsRoot);
    __setActiveChannelCredentialsStoreModeForTests("keyring");
    await upsertChannelAccountWithSecrets(
      "schemasecret",
      makeSchemaSecretAccount(),
    );
    await flushPendingChannelSecretWrites();
    secrets.clear();
    clearChannelAccountStores();

    const beforeText = readFileSync(
      join(channelsRoot, "schemasecret", "accounts.json"),
      "utf-8",
    );

    await expect(hydrateChannelAccountSecrets("schemasecret")).rejects.toThrow(
      /saved secret reference was preserved/i,
    );

    const afterText = readFileSync(
      join(channelsRoot, "schemasecret", "accounts.json"),
      "utf-8",
    );
    expect(afterText).toBe(beforeText);
    const persisted = JSON.parse(afterText) as {
      accounts: Array<
        { config?: Record<string, unknown> } & Record<string, unknown>
      >;
    };
    expect(persisted.accounts[0]).toMatchObject({
      __letta_secret_refs: {
        "config.api_key": true,
      },
    });
    expect(persisted.accounts[0]?.config).not.toHaveProperty("api_key", "");
  });

  test("persisted plugin secret refs hydrate and delete without plugin metadata", async () => {
    __setActiveChannelCredentialsStoreModeForTests("keyring");
    mkdirSync(join(channelsRoot, "schemasecret"), { recursive: true });
    writeFileSync(
      join(channelsRoot, "schemasecret", "accounts.json"),
      `${JSON.stringify(
        {
          accounts: [
            {
              channel: "schemasecret",
              accountId: "schema-account",
              enabled: true,
              dmPolicy: "pairing",
              allowedUsers: [],
              config: {
                endpoint: "https://example.test/webhook",
              },
              __letta_secret_refs: {
                "config.api_key": true,
              },
              createdAt: "2026-05-26T00:00:00.000Z",
              updatedAt: "2026-05-26T00:00:00.000Z",
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    secrets.set(
      buildChannelSecretName(
        "schemasecret",
        "schema-account",
        "config.api_key",
      ),
      "schema-secret",
    );
    __testClearUserChannelPluginCache();
    clearChannelAccountStores();

    const hydrated = (await getChannelAccountWithSecrets(
      "schemasecret",
      "schema-account",
    )) as CustomChannelAccount | null;

    expect(hydrated?.config).toEqual(
      expect.objectContaining({
        endpoint: "https://example.test/webhook",
        api_key: "schema-secret",
      }),
    );

    expect(
      await removeChannelAccountWithSecrets("schemasecret", "schema-account"),
    ).toBe(true);
    expect(
      secrets.has(
        buildChannelSecretName(
          "schemasecret",
          "schema-account",
          "config.api_key",
        ),
      ),
    ).toBe(false);
  });

  test("auto falls back to file mode when keyring is unavailable", async () => {
    __setChannelCredentialsStoreModeForTests("auto");
    __setChannelKeychainAvailableForTests(false);

    expect(await getActiveChannelCredentialsStoreMode()).toBe("file");
  });

  test("explicit keyring mode errors when keyring is unavailable", async () => {
    __setChannelCredentialsStoreModeForTests("keyring");
    __setChannelKeychainAvailableForTests(false);

    await expect(getActiveChannelCredentialsStoreMode()).rejects.toThrow(
      "OS secure storage is unavailable",
    );
  });

  test("file mode preserves plaintext accounts.json compatibility", async () => {
    __setActiveChannelCredentialsStoreModeForTests("file");

    await upsertChannelAccountWithSecrets("slack", makeSlackAccount());

    const persistedText = readFileSync(
      join(channelsRoot, "slack", "accounts.json"),
      "utf-8",
    );
    expect(persistedText).toContain("xoxb-secret");
    expect(persistedText).toContain("xapp-secret");
    expect(persistedText).not.toContain("__letta_secret_refs");
    expect(existsSync(join(channelsRoot, "slack", "accounts.json"))).toBe(true);
  });

  test("file mode refuses to rewrite accounts that still contain keyring refs", async () => {
    __setActiveChannelCredentialsStoreModeForTests("keyring");
    await upsertChannelAccountWithSecrets("slack", makeSlackAccount());
    await flushPendingChannelSecretWrites();
    const beforeText = readFileSync(
      join(channelsRoot, "slack", "accounts.json"),
      "utf-8",
    );

    clearChannelAccountStores();
    __setActiveChannelCredentialsStoreModeForTests("file");
    const account = (await getChannelAccountWithSecrets(
      "slack",
      "slack-account",
    )) as SlackChannelAccount | null;
    if (!account) {
      throw new Error("Expected slack account to load from accounts.json");
    }

    await expect(
      upsertChannelAccountWithSecrets("slack", {
        ...account,
        displayName: "Renamed Slack",
      }),
    ).rejects.toThrow(/Cannot save slack\/slack-account\/botToken/);

    const afterText = readFileSync(
      join(channelsRoot, "slack", "accounts.json"),
      "utf-8",
    );
    expect(afterText).toBe(beforeText);
  });
});
