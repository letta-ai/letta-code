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
  __testOverrideSaveChannelAccounts,
  clearChannelAccountStores,
  flushPendingChannelSecretWrites,
  getChannelAccount,
  getChannelAccountWithSecrets,
  removeChannelAccountWithSecrets,
  upsertChannelAccountWithSecrets,
} from "@/channels/accounts";
import {
  __testOverrideChannelsRoot,
  getChannelRoutingPath,
} from "@/channels/config";
import {
  __setActiveChannelCredentialsStoreModeForTests,
  __setChannelSecretStoreOverrideForTests,
  buildChannelSecretName,
} from "@/channels/credential-store";
import {
  clearPairingStores,
  consumePairingCode,
  createPairingCode,
  getApprovedUsers,
  getPendingPairings,
} from "@/channels/pairing";
import { __testClearUserChannelPluginCache } from "@/channels/plugin-registry";
import { getChannelRegistry } from "@/channels/registry";
import {
  __testOverrideSaveRoutes,
  addRoute,
  clearAllRoutes,
  getRoutesForChannel,
} from "@/channels/routing";
import {
  bindChannelAccountLive,
  createChannelAccountLiveWithSecrets,
  removeChannelAccountLive,
  startChannelAccountLive,
  updateChannelAccountLiveWithSecrets,
} from "@/channels/service";
import {
  clearTargetStores,
  listChannelTargets,
  upsertChannelTarget,
} from "@/channels/targets";
import type {
  CustomChannelAccount,
  SlackChannelAccount,
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

function writeFailingSchemaChannel(root: string): void {
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
          fields: [{ type: "secret", key: "api_key", label: "API Key" }],
        },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(channelDir, "plugin.mjs"),
    "export const channelPlugin = { metadata: { id: 'schemasecret', displayName: 'Schema Secret' }, createAdapter() { return { id: 'schemasecret:schema-account', channelId: 'schemasecret', accountId: 'schema-account', name: 'Schema Secret', async start() { throw new Error('adapter start failed'); }, async stop() {}, isRunning() { return false; }, async sendMessage() { return { messageId: 'unused' }; } }; } };\n",
  );
}

function makeSchemaAccount(): CustomChannelAccount {
  return {
    channel: "schemasecret",
    accountId: "schema-account",
    enabled: false,
    dmPolicy: "pairing",
    allowedUsers: [],
    config: { api_key: "schema-secret" },
    createdAt: "2026-05-26T00:00:00.000Z",
    updatedAt: "2026-05-26T00:00:00.000Z",
  };
}

describe("channel credential transaction boundaries", () => {
  let channelsRoot: string;
  let secrets: Map<string, string>;

  beforeEach(() => {
    channelsRoot = mkdtempSync(join(tmpdir(), "letta-channel-txn-"));
    secrets = new Map<string, string>();
    clearChannelAccountStores();
    clearAllRoutes();
    clearPairingStores();
    clearTargetStores();
    __testOverrideChannelsRoot(channelsRoot);
    __testClearUserChannelPluginCache();
    __setActiveChannelCredentialsStoreModeForTests("keyring");
    __setChannelSecretStoreOverrideForTests({
      get: async (name) => secrets.get(name) ?? null,
      set: async (name, value) => {
        secrets.set(name, value);
      },
      delete: async (name) => secrets.delete(name),
    });
  });

  afterEach(async () => {
    await getChannelRegistry()?.stopAll();
    clearChannelAccountStores();
    clearAllRoutes();
    clearPairingStores();
    clearTargetStores();
    __testOverrideChannelsRoot(null);
    __testClearUserChannelPluginCache();
    __setActiveChannelCredentialsStoreModeForTests(null);
    __setChannelSecretStoreOverrideForTests(null);
    __testOverrideSaveChannelAccounts(null);
    __testOverrideSaveRoutes(null);
    rmSync(channelsRoot, { recursive: true, force: true });
  });

  test("secret-aware creates roll back partial keyring writes on failure", async () => {
    const botSecretName = buildChannelSecretName(
      "slack",
      "slack-account",
      "botToken",
    );
    const appSecretName = buildChannelSecretName(
      "slack",
      "slack-account",
      "appToken",
    );
    __setChannelSecretStoreOverrideForTests({
      get: async (name) => secrets.get(name) ?? null,
      set: async (name, value) => {
        if (name === appSecretName) {
          throw new Error("keyring write failed");
        }
        secrets.set(name, value);
      },
      delete: async (name) => secrets.delete(name),
    });

    await expect(
      upsertChannelAccountWithSecrets("slack", makeSlackAccount()),
    ).rejects.toThrow("keyring write failed");

    expect(getChannelAccount("slack", "slack-account")).toBeNull();
    expect(existsSync(join(channelsRoot, "slack", "accounts.json"))).toBe(
      false,
    );
    expect(secrets.has(botSecretName)).toBe(false);
    expect(secrets.has(appSecretName)).toBe(false);
    await expect(flushPendingChannelSecretWrites()).resolves.toBeUndefined();
    expect(secrets.has(botSecretName)).toBe(false);
  });

  test("secret-aware updates restore account storage and sibling keyring values on failure", async () => {
    await upsertChannelAccountWithSecrets("slack", {
      ...makeSlackAccount(),
      displayName: "Slack Old",
    });
    await flushPendingChannelSecretWrites();

    const botSecretName = buildChannelSecretName(
      "slack",
      "slack-account",
      "botToken",
    );
    const appSecretName = buildChannelSecretName(
      "slack",
      "slack-account",
      "appToken",
    );
    __setChannelSecretStoreOverrideForTests({
      get: async (name) => secrets.get(name) ?? null,
      set: async (name, value) => {
        if (name === appSecretName) {
          throw new Error("keyring write failed");
        }
        secrets.set(name, value);
      },
      delete: async (name) => secrets.delete(name),
    });

    await expect(
      upsertChannelAccountWithSecrets("slack", {
        ...makeSlackAccount(),
        displayName: "Slack New",
        botToken: "xoxb-new-secret",
        appToken: "xapp-new-secret",
      }),
    ).rejects.toThrow("keyring write failed");

    const persisted = readAccountsFile(channelsRoot, "slack") as {
      accounts: Array<Record<string, unknown>>;
    };
    expect(persisted.accounts).toHaveLength(1);
    expect(persisted.accounts[0]).toMatchObject({
      accountId: "slack-account",
      displayName: "Slack Old",
    });
    expect(JSON.stringify(persisted)).not.toContain("Slack New");
    expect(getChannelAccount("slack", "slack-account")).toEqual(
      expect.objectContaining({
        displayName: "Slack Old",
        botToken: "xoxb-secret",
        appToken: "xapp-secret",
      }),
    );
    expect(secrets.get(botSecretName)).toBe("xoxb-secret");
    expect(secrets.get(appSecretName)).toBe("xapp-secret");
    await expect(flushPendingChannelSecretWrites()).resolves.toBeUndefined();
    expect(secrets.get(botSecretName)).toBe("xoxb-secret");
  });

  test("secret-aware update rollback does not overwrite concurrent sibling mutations", async () => {
    await upsertChannelAccountWithSecrets("slack", {
      ...makeSlackAccount(),
      accountId: "slack-a",
      displayName: "Slack A Old",
      botToken: "xoxb-a-old",
      appToken: "xapp-a-old",
    });
    await upsertChannelAccountWithSecrets("slack", {
      ...makeSlackAccount(),
      accountId: "slack-b",
      displayName: "Slack B Old",
      botToken: "xoxb-b-old",
      appToken: "xapp-b-old",
    });
    await flushPendingChannelSecretWrites();

    let releaseAWrite: () => void = () => {};
    const aWriteMayContinue = new Promise<void>((resolve) => {
      releaseAWrite = resolve;
    });
    let aWriteStarted: () => void = () => {};
    const aWriteHasStarted = new Promise<void>((resolve) => {
      aWriteStarted = resolve;
    });
    const aBotSecret = buildChannelSecretName("slack", "slack-a", "botToken");
    __setChannelSecretStoreOverrideForTests({
      get: async (name) => secrets.get(name) ?? null,
      set: async (name, value) => {
        if (name === aBotSecret && value === "xoxb-a-new") {
          aWriteStarted();
          await aWriteMayContinue;
        }
        secrets.set(name, value);
      },
      delete: async (name) => secrets.delete(name),
    });
    __testOverrideSaveChannelAccounts((channelId, accounts) => {
      if (
        accounts.some(
          (account) =>
            account.accountId === "slack-a" &&
            account.displayName === "Slack A New",
        )
      ) {
        throw new Error("account save failed");
      }
      mkdirSync(join(channelsRoot, channelId), { recursive: true });
      writeFileSync(
        join(channelsRoot, channelId, "accounts.json"),
        `${JSON.stringify({ accounts }, null, 2)}\n`,
      );
    });

    const updateA = upsertChannelAccountWithSecrets("slack", {
      ...makeSlackAccount(),
      accountId: "slack-a",
      displayName: "Slack A New",
      botToken: "xoxb-a-new",
      appToken: "xapp-a-new",
    });
    await aWriteHasStarted;
    await upsertChannelAccountWithSecrets("slack", {
      ...makeSlackAccount(),
      accountId: "slack-b",
      displayName: "Slack B New",
      botToken: "xoxb-b-new",
      appToken: "xapp-b-new",
    });
    releaseAWrite();

    await expect(updateA).rejects.toThrow("account save failed");

    const persisted = readAccountsFile(channelsRoot, "slack") as {
      accounts: Array<Record<string, unknown>>;
    };
    expect(persisted.accounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          accountId: "slack-a",
          displayName: "Slack A Old",
        }),
        expect.objectContaining({
          accountId: "slack-b",
          displayName: "Slack B New",
        }),
      ]),
    );
    expect(getChannelAccount("slack", "slack-a")).toEqual(
      expect.objectContaining({
        displayName: "Slack A Old",
        botToken: "xoxb-a-old",
        appToken: "xapp-a-old",
      }),
    );
    expect(getChannelAccount("slack", "slack-b")).toEqual(
      expect.objectContaining({
        displayName: "Slack B New",
        botToken: "xoxb-b-new",
        appToken: "xapp-b-new",
      }),
    );
    expect(
      secrets.get(buildChannelSecretName("slack", "slack-a", "botToken")),
    ).toBe("xoxb-a-old");
    expect(
      secrets.get(buildChannelSecretName("slack", "slack-a", "appToken")),
    ).toBe("xapp-a-old");
    expect(
      secrets.get(buildChannelSecretName("slack", "slack-b", "botToken")),
    ).toBe("xoxb-b-new");
    expect(
      secrets.get(buildChannelSecretName("slack", "slack-b", "appToken")),
    ).toBe("xapp-b-new");
  });

  test("same-account concurrent stale patches conflict instead of losing fields", async () => {
    await upsertChannelAccountWithSecrets("slack", {
      ...makeSlackAccount(),
      displayName: "Base",
      allowedUsers: [],
    });
    await flushPendingChannelSecretWrites();

    const displayNameUpdate = updateChannelAccountLiveWithSecrets(
      "slack",
      "slack-account",
      { displayName: "First" },
    );
    const allowedUsersUpdate = updateChannelAccountLiveWithSecrets(
      "slack",
      "slack-account",
      { allowedUsers: ["U-stale"] },
    );

    const results = await Promise.allSettled([
      displayNameUpdate,
      allowedUsersUpdate,
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(rejected?.reason).toBeInstanceOf(Error);
    expect((rejected?.reason as Error).message).toContain("Retry");

    const finalAccount = getChannelAccount(
      "slack",
      "slack-account",
    ) as SlackChannelAccount | null;
    expect(finalAccount).not.toBeNull();
    if (finalAccount?.displayName === "First") {
      expect(finalAccount.allowedUsers).toEqual([]);
    } else {
      expect(finalAccount?.displayName).toBe("Base");
      expect(finalAccount?.allowedUsers).toEqual(["U-stale"]);
    }
  });

  test("metadata binding survives a delayed conflicting credential update", async () => {
    await upsertChannelAccountWithSecrets("slack", {
      ...makeSlackAccount(),
      displayName: "Slack Old",
      agentId: "agent-old",
      botToken: "xoxb-old",
      appToken: "xapp-old",
    });
    await flushPendingChannelSecretWrites();

    const botSecretName = buildChannelSecretName(
      "slack",
      "slack-account",
      "botToken",
    );
    let releaseBotWrite: () => void = () => {};
    const botWriteMayContinue = new Promise<void>((resolve) => {
      releaseBotWrite = resolve;
    });
    let botWriteStarted: () => void = () => {};
    const botWriteHasStarted = new Promise<void>((resolve) => {
      botWriteStarted = resolve;
    });
    __setChannelSecretStoreOverrideForTests({
      get: async (name) => secrets.get(name) ?? null,
      set: async (name, value) => {
        if (name === botSecretName && value === "xoxb-new") {
          botWriteStarted();
          await botWriteMayContinue;
        }
        secrets.set(name, value);
      },
      delete: async (name) => secrets.delete(name),
    });

    const credentialUpdate = updateChannelAccountLiveWithSecrets(
      "slack",
      "slack-account",
      {
        displayName: "Slack New",
        botToken: "xoxb-new",
        appToken: "xapp-new",
      },
    );
    await botWriteHasStarted;

    await expect(
      bindChannelAccountLive(
        "slack",
        "slack-account",
        "agent-bound",
        "conv-bound",
      ),
    ).resolves.toEqual(expect.objectContaining({ agentId: "agent-bound" }));

    releaseBotWrite();
    await expect(credentialUpdate).rejects.toThrow("Retry");

    const finalAccount = getChannelAccount(
      "slack",
      "slack-account",
    ) as SlackChannelAccount | null;
    expect(finalAccount).toEqual(
      expect.objectContaining({
        displayName: "Slack Old",
        agentId: "agent-bound",
      }),
    );
    expect(secrets.get(botSecretName)).toBe("xoxb-old");
    expect(
      secrets.get(buildChannelSecretName("slack", "slack-account", "appToken")),
    ).toBe("xapp-old");
  });

  test("delayed plaintext hydration cannot overwrite a concurrent credential update", async () => {
    mkdirSync(join(channelsRoot, "slack"), { recursive: true });
    writeFileSync(
      join(channelsRoot, "slack", "accounts.json"),
      `${JSON.stringify(
        {
          accounts: [
            {
              ...makeSlackAccount(),
              displayName: "Plaintext Slack",
              botToken: "xoxb-old-plaintext",
              appToken: "xapp-old-plaintext",
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    clearChannelAccountStores();

    const botSecretName = buildChannelSecretName(
      "slack",
      "slack-account",
      "botToken",
    );
    const appSecretName = buildChannelSecretName(
      "slack",
      "slack-account",
      "appToken",
    );
    const botWrites: string[] = [];
    let releasePlaintextWrite: () => void = () => {};
    const plaintextWriteMayContinue = new Promise<void>((resolve) => {
      releasePlaintextWrite = resolve;
    });
    let plaintextWriteStarted: () => void = () => {};
    const plaintextWriteHasStarted = new Promise<void>((resolve) => {
      plaintextWriteStarted = resolve;
    });
    __setChannelSecretStoreOverrideForTests({
      get: async (name) => secrets.get(name) ?? null,
      set: async (name, value) => {
        if (name === botSecretName) {
          botWrites.push(value);
          if (value === "xoxb-old-plaintext") {
            plaintextWriteStarted();
            await plaintextWriteMayContinue;
          }
        }
        secrets.set(name, value);
      },
      delete: async (name) => secrets.delete(name),
    });

    const hydration = getChannelAccountWithSecrets("slack", "slack-account");
    await plaintextWriteHasStarted;
    const credentialUpdate = updateChannelAccountLiveWithSecrets(
      "slack",
      "slack-account",
      {
        botToken: "xoxb-new-secret",
        appToken: "xapp-new-secret",
      },
    );

    releasePlaintextWrite();
    await expect(hydration).resolves.toEqual(
      expect.objectContaining({ botToken: "xoxb-old-plaintext" }),
    );
    await expect(credentialUpdate).resolves.toEqual(
      expect.objectContaining({ configured: true }),
    );

    expect(secrets.get(botSecretName)).toBe("xoxb-new-secret");
    expect(secrets.get(appSecretName)).toBe("xapp-new-secret");
    expect(botWrites).toEqual(["xoxb-old-plaintext", "xoxb-new-secret"]);
  });

  test("secret-aware updates can repair missing old refs with new credentials", async () => {
    await upsertChannelAccountWithSecrets("slack", {
      ...makeSlackAccount(),
      displayName: "Slack Broken",
    });
    await flushPendingChannelSecretWrites();
    secrets.clear();
    clearChannelAccountStores();

    await expect(
      updateChannelAccountLiveWithSecrets("slack", "slack-account", {
        botToken: "xoxb-repaired-secret",
        appToken: "xapp-repaired-secret",
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        accountId: "slack-account",
        configured: true,
      }),
    );

    expect(
      secrets.get(buildChannelSecretName("slack", "slack-account", "botToken")),
    ).toBe("xoxb-repaired-secret");
    expect(
      secrets.get(buildChannelSecretName("slack", "slack-account", "appToken")),
    ).toBe("xapp-repaired-secret");
    const persisted = readAccountsFile(channelsRoot, "slack") as {
      accounts: Array<Record<string, unknown>>;
    };
    expect(JSON.stringify(persisted)).not.toContain("xoxb-repaired-secret");
    expect(persisted.accounts[0]).toMatchObject({
      accountId: "slack-account",
      displayName: "Slack Broken",
      __letta_secret_refs: {
        botToken: true,
        appToken: true,
      },
    });
  });

  test("secret-aware agent updates roll back account, keyring, and routes when route reset fails", async () => {
    await upsertChannelAccountWithSecrets("slack", {
      ...makeSlackAccount(),
      displayName: "Slack Old",
      agentId: "agent-old",
      botToken: "xoxb-old",
      appToken: "xapp-old",
    });
    await flushPendingChannelSecretWrites();
    const now = "2026-05-26T00:00:00.000Z";
    addRoute("slack", {
      accountId: "slack-account",
      chatId: "C-route",
      chatType: "channel",
      agentId: "agent-old",
      conversationId: "conv-old",
      enabled: true,
      outboundEnabled: true,
      detached: false,
      createdAt: now,
      updatedAt: now,
    });
    const beforeRoutesText = readFileSync(
      getChannelRoutingPath("slack"),
      "utf-8",
    );
    const beforeRoutes = getRoutesForChannel("slack", "slack-account");
    __testOverrideSaveRoutes(() => {
      throw new Error("route save failed");
    });

    await expect(
      updateChannelAccountLiveWithSecrets("slack", "slack-account", {
        agentId: "agent-new",
        botToken: "xoxb-new",
        appToken: "xapp-new",
      }),
    ).rejects.toThrow(/Account changes were rolled back/);

    const afterRoutesText = readFileSync(
      getChannelRoutingPath("slack"),
      "utf-8",
    );
    expect(afterRoutesText).toBe(beforeRoutesText);
    expect(getRoutesForChannel("slack", "slack-account")).toEqual(beforeRoutes);
    const persisted = readAccountsFile(channelsRoot, "slack") as {
      accounts: Array<Record<string, unknown>>;
    };
    expect(persisted.accounts[0]).toMatchObject({
      accountId: "slack-account",
      displayName: "Slack Old",
      agentId: "agent-old",
    });
    expect(getChannelAccount("slack", "slack-account")).toEqual(
      expect.objectContaining({
        agentId: "agent-old",
        botToken: "xoxb-old",
        appToken: "xapp-old",
      }),
    );
    expect(
      secrets.get(buildChannelSecretName("slack", "slack-account", "botToken")),
    ).toBe("xoxb-old");
    expect(
      secrets.get(buildChannelSecretName("slack", "slack-account", "appToken")),
    ).toBe("xapp-old");
  });

  test("secret-aware deletes compensate partial keyring deletion failures", async () => {
    await upsertChannelAccountWithSecrets("slack", {
      ...makeSlackAccount(),
      displayName: "Slack Old",
    });
    await flushPendingChannelSecretWrites();
    const botSecretName = buildChannelSecretName(
      "slack",
      "slack-account",
      "botToken",
    );
    const appSecretName = buildChannelSecretName(
      "slack",
      "slack-account",
      "appToken",
    );
    __setChannelSecretStoreOverrideForTests({
      get: async (name) => secrets.get(name) ?? null,
      set: async (name, value) => {
        secrets.set(name, value);
      },
      delete: async (name) => {
        if (name === appSecretName) {
          throw new Error("keyring delete failed");
        }
        return secrets.delete(name);
      },
    });

    await expect(
      removeChannelAccountWithSecrets("slack", "slack-account"),
    ).rejects.toThrow("keyring delete failed");

    const persisted = readAccountsFile(channelsRoot, "slack") as {
      accounts: Array<Record<string, unknown>>;
    };
    expect(persisted.accounts).toHaveLength(1);
    expect(persisted.accounts[0]).toMatchObject({
      accountId: "slack-account",
      displayName: "Slack Old",
    });
    expect(getChannelAccount("slack", "slack-account")).toEqual(
      expect.objectContaining({
        displayName: "Slack Old",
        botToken: "xoxb-secret",
        appToken: "xapp-secret",
      }),
    );
    expect(secrets.get(botSecretName)).toBe("xoxb-secret");
    expect(secrets.get(appSecretName)).toBe("xapp-secret");
  });

  test("secret-aware deletes restore account and secrets when account removal save fails", async () => {
    await upsertChannelAccountWithSecrets("slack", {
      ...makeSlackAccount(),
      displayName: "Slack Old",
    });
    await flushPendingChannelSecretWrites();
    const botSecretName = buildChannelSecretName(
      "slack",
      "slack-account",
      "botToken",
    );
    const appSecretName = buildChannelSecretName(
      "slack",
      "slack-account",
      "appToken",
    );
    __testOverrideSaveChannelAccounts((channelId, accounts) => {
      if (accounts.length === 0) {
        throw new Error("account save failed");
      }
      mkdirSync(join(channelsRoot, channelId), { recursive: true });
      writeFileSync(
        join(channelsRoot, channelId, "accounts.json"),
        `${JSON.stringify({ accounts }, null, 2)}\n`,
      );
    });

    await expect(
      removeChannelAccountWithSecrets("slack", "slack-account"),
    ).rejects.toThrow("account save failed");

    const persisted = readAccountsFile(channelsRoot, "slack") as {
      accounts: Array<Record<string, unknown>>;
    };
    expect(persisted.accounts).toHaveLength(1);
    expect(persisted.accounts[0]).toMatchObject({
      accountId: "slack-account",
      displayName: "Slack Old",
    });
    expect(getChannelAccount("slack", "slack-account")).toEqual(
      expect.objectContaining({
        displayName: "Slack Old",
        botToken: "xoxb-secret",
        appToken: "xapp-secret",
      }),
    );
    expect(secrets.get(botSecretName)).toBe("xoxb-secret");
    expect(secrets.get(appSecretName)).toBe("xapp-secret");
  });

  test("live account delete removes keyring secrets", async () => {
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

  test("live account start failure rolls back secret-aware enablement", async () => {
    writeFailingSchemaChannel(channelsRoot);
    await upsertChannelAccountWithSecrets("schemasecret", makeSchemaAccount());
    await flushPendingChannelSecretWrites();

    await expect(
      startChannelAccountLive("schemasecret", "schema-account"),
    ).rejects.toThrow("adapter start failed");

    expect(getChannelAccount("schemasecret", "schema-account")).toEqual(
      expect.objectContaining({
        enabled: false,
        config: expect.objectContaining({ api_key: "schema-secret" }),
      }),
    );
    const persisted = readAccountsFile(channelsRoot, "schemasecret") as {
      accounts: Array<Record<string, unknown>>;
    };
    expect(persisted.accounts[0]).toMatchObject({
      accountId: "schema-account",
      enabled: false,
      __letta_secret_refs: { "config.api_key": true },
    });
    expect(JSON.stringify(persisted)).not.toContain("schema-secret");
    expect(
      secrets.get(
        buildChannelSecretName(
          "schemasecret",
          "schema-account",
          "config.api_key",
        ),
      ),
    ).toBe("schema-secret");
  });

  test("live account delete rolls account and secrets back when route cleanup fails", async () => {
    await createChannelAccountLiveWithSecrets(
      "slack",
      {
        enabled: false,
        mode: "socket",
        botToken: "xoxb-secret",
        appToken: "xapp-secret",
        dmPolicy: "pairing",
        agentId: "agent-1",
      },
      { accountId: "slack-account" },
    );
    await flushPendingChannelSecretWrites();
    const now = "2026-05-26T00:00:00.000Z";
    addRoute("slack", {
      accountId: "slack-account",
      chatId: "C-route",
      chatType: "channel",
      agentId: "agent-route",
      conversationId: "conv-route",
      enabled: true,
      outboundEnabled: true,
      detached: false,
      createdAt: now,
      updatedAt: now,
    });
    const beforeRoutesText = readFileSync(
      getChannelRoutingPath("slack"),
      "utf-8",
    );
    const beforeRoutes = getRoutesForChannel("slack", "slack-account");
    __testOverrideSaveRoutes(() => {
      throw new Error("route cleanup failed");
    });

    await expect(
      removeChannelAccountLive("slack", "slack-account"),
    ).rejects.toThrow(/Account changes were rolled back/);

    expect(readFileSync(getChannelRoutingPath("slack"), "utf-8")).toBe(
      beforeRoutesText,
    );
    expect(getRoutesForChannel("slack", "slack-account")).toEqual(beforeRoutes);
    expect(getChannelAccount("slack", "slack-account")).toEqual(
      expect.objectContaining({
        botToken: "xoxb-secret",
        appToken: "xapp-secret",
      }),
    );
    expect(
      secrets.get(buildChannelSecretName("slack", "slack-account", "botToken")),
    ).toBe("xoxb-secret");
    expect(
      secrets.get(buildChannelSecretName("slack", "slack-account", "appToken")),
    ).toBe("xapp-secret");
  });

  test("live account delete preserves auxiliary account state when credential deletion fails", async () => {
    await createChannelAccountLiveWithSecrets(
      "slack",
      {
        enabled: false,
        mode: "socket",
        botToken: "xoxb-secret",
        appToken: "xapp-secret",
        dmPolicy: "pairing",
        agentId: "agent-1",
      },
      { accountId: "slack-account" },
    );
    await flushPendingChannelSecretWrites();

    const now = "2026-05-26T00:00:00.000Z";
    addRoute("slack", {
      accountId: "slack-account",
      chatId: "C-route",
      chatType: "channel",
      agentId: "agent-route",
      conversationId: "conv-route",
      enabled: true,
      outboundEnabled: true,
      detached: false,
      createdAt: now,
      updatedAt: now,
    });
    upsertChannelTarget("slack", {
      accountId: "slack-account",
      targetId: "target-1",
      targetType: "channel",
      chatId: "C-target",
      label: "target",
      discoveredAt: now,
      lastSeenAt: now,
    });
    createPairingCode(
      "slack",
      "U-pending",
      "D-pending",
      "Pending User",
      "slack-account",
    );
    const approvedCode = createPairingCode(
      "slack",
      "U-approved",
      "D-approved",
      "Approved User",
      "slack-account",
    );
    expect(consumePairingCode("slack", approvedCode, "slack-account")).not.toBe(
      null,
    );

    const botSecretName = buildChannelSecretName(
      "slack",
      "slack-account",
      "botToken",
    );
    const appSecretName = buildChannelSecretName(
      "slack",
      "slack-account",
      "appToken",
    );
    __setChannelSecretStoreOverrideForTests({
      get: async (name) => secrets.get(name) ?? null,
      set: async (name, value) => {
        secrets.set(name, value);
      },
      delete: async (name) => {
        if (name === appSecretName) {
          throw new Error("keyring delete failed");
        }
        return secrets.delete(name);
      },
    });

    await expect(
      removeChannelAccountLive("slack", "slack-account"),
    ).rejects.toThrow("keyring delete failed");

    const persisted = readAccountsFile(channelsRoot, "slack") as {
      accounts: Array<Record<string, unknown>>;
    };
    expect(persisted.accounts).toHaveLength(1);
    expect(getChannelAccount("slack", "slack-account")).toEqual(
      expect.objectContaining({
        botToken: "xoxb-secret",
        appToken: "xapp-secret",
      }),
    );
    expect(secrets.get(botSecretName)).toBe("xoxb-secret");
    expect(secrets.get(appSecretName)).toBe("xapp-secret");
    expect(getRoutesForChannel("slack", "slack-account")).toHaveLength(1);
    expect(listChannelTargets("slack", "slack-account")).toHaveLength(1);
    expect(getPendingPairings("slack", "slack-account")).toHaveLength(1);
    expect(getApprovedUsers("slack", "slack-account")).toHaveLength(1);
  });
});
