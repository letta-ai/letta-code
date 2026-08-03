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
  upsertChannelAccount,
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
import {
  bindChannelAccountLive,
  createChannelAccountLiveWithSecrets,
} from "@/channels/service-accounts";
import type {
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

function makeTelegramAccountWithSecretRef(): Record<string, unknown> {
  return {
    channel: "telegram",
    accountId: "telegram-account",
    enabled: true,
    dmPolicy: "pairing",
    allowedUsers: [],
    binding: {
      agentId: null,
      conversationId: null,
    },
    transcribe_voice: false,
    rich_private_chat_default: true,
    createdAt: "2026-05-26T00:00:00.000Z",
    updatedAt: "2026-05-26T00:00:00.000Z",
    __letta_secret_refs: {
      token: true,
    },
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

  test("secure Telegram create preserves refs through synchronous account binding", async () => {
    __setActiveChannelCredentialsStoreModeForTests("keyring");

    await createChannelAccountLiveWithSecrets(
      "telegram",
      {
        displayName: "Telegram Bot",
        enabled: false,
        dmPolicy: "pairing",
        allowedUsers: [],
        config: {
          token: "telegram-secret",
          transcribe_voice: false,
        },
      },
      { accountId: "telegram-account" },
    );

    bindChannelAccountLive(
      "telegram",
      "telegram-account",
      "agent-1",
      "conversation-1",
    );

    const persistedText = readFileSync(
      join(channelsRoot, "telegram", "accounts.json"),
      "utf-8",
    );
    expect(persistedText).not.toContain("telegram-secret");
    const persisted = JSON.parse(persistedText) as {
      accounts: Array<Record<string, unknown>>;
    };
    expect(persisted.accounts[0]).toMatchObject({
      binding: {
        agentId: "agent-1",
        conversationId: "conversation-1",
      },
      __letta_secret_refs: { token: true },
    });
    expect(
      secrets.get(
        buildChannelSecretName("telegram", "telegram-account", "token"),
      ),
    ).toBe("telegram-secret");
  });

  test("failed multi-secret update restores keyring and persisted account state", async () => {
    __setActiveChannelCredentialsStoreModeForTests("keyring");
    await upsertChannelAccountWithSecrets("slack", makeSlackAccount());

    const botTokenName = buildChannelSecretName(
      "slack",
      "slack-account",
      "botToken",
    );
    const appTokenName = buildChannelSecretName(
      "slack",
      "slack-account",
      "appToken",
    );
    __setChannelSecretStoreOverrideForTests({
      get: async (name) => secrets.get(name) ?? null,
      set: async (name, value) => {
        if (name === appTokenName && value === "xapp-new") {
          throw new Error("second keyring write failed");
        }
        secrets.set(name, value);
      },
      delete: async (name) => secrets.delete(name),
    });

    await expect(
      upsertChannelAccountWithSecrets("slack", {
        ...makeSlackAccount(),
        botToken: "xoxb-new",
        appToken: "xapp-new",
      }),
    ).rejects.toThrow("second keyring write failed");

    expect(secrets.get(botTokenName)).toBe("xoxb-secret");
    expect(secrets.get(appTokenName)).toBe("xapp-secret");
    const persistedText = readFileSync(
      join(channelsRoot, "slack", "accounts.json"),
      "utf-8",
    );
    expect(persistedText).not.toContain("xoxb-secret");
    expect(persistedText).not.toContain("xapp-secret");
    expect(persistedText).not.toContain("xoxb-new");
    expect(persistedText).not.toContain("xapp-new");
    expect(JSON.parse(persistedText).accounts[0]).toMatchObject({
      __letta_secret_refs: {
        botToken: true,
        appToken: true,
      },
    });

    clearChannelAccountStores();
    const rehydrated = (await getChannelAccountWithSecrets(
      "slack",
      "slack-account",
    )) as SlackChannelAccount | null;
    expect(rehydrated?.botToken).toBe("xoxb-secret");
    expect(rehydrated?.appToken).toBe("xapp-secret");
  });

  test("serializes concurrent updates before rollback and file commit", async () => {
    __setActiveChannelCredentialsStoreModeForTests("keyring");
    await upsertChannelAccountWithSecrets("slack", makeSlackAccount());

    const botTokenName = buildChannelSecretName(
      "slack",
      "slack-account",
      "botToken",
    );
    const appTokenName = buildChannelSecretName(
      "slack",
      "slack-account",
      "appToken",
    );
    let signalFirstUpdateAtSecondWrite: () => void = () => {};
    const firstUpdateAtSecondWrite = new Promise<void>((resolve) => {
      signalFirstUpdateAtSecondWrite = resolve;
    });
    let releaseFirstUpdateFailure: () => void = () => {};
    const allowFirstUpdateFailure = new Promise<void>((resolve) => {
      releaseFirstUpdateFailure = resolve;
    });
    __setChannelSecretStoreOverrideForTests({
      get: async (name) => secrets.get(name) ?? null,
      set: async (name, value) => {
        if (name === appTokenName && value === "xapp-first") {
          signalFirstUpdateAtSecondWrite();
          await allowFirstUpdateFailure;
          throw new Error("first update second write failed");
        }
        secrets.set(name, value);
      },
      delete: async (name) => secrets.delete(name),
    });

    const firstUpdate = upsertChannelAccountWithSecrets("slack", {
      ...makeSlackAccount(),
      botToken: "xoxb-first",
      appToken: "xapp-first",
    });
    await firstUpdateAtSecondWrite;

    let secondUpdateSettled = false;
    const secondUpdate = upsertChannelAccountWithSecrets("slack", {
      ...makeSlackAccount(),
      appToken: "xapp-second",
    }).then(
      (account) => {
        secondUpdateSettled = true;
        return account;
      },
      (error) => {
        secondUpdateSettled = true;
        throw error;
      },
    );
    await Promise.resolve();
    expect(secondUpdateSettled).toBe(false);

    releaseFirstUpdateFailure();
    await expect(firstUpdate).rejects.toThrow(
      "first update second write failed",
    );
    const secondAccount = (await secondUpdate) as SlackChannelAccount;

    expect(secondAccount.botToken).toBe("xoxb-secret");
    expect(secondAccount.appToken).toBe("xapp-second");
    expect(secrets.get(botTokenName)).toBe("xoxb-secret");
    expect(secrets.get(appTokenName)).toBe("xapp-second");
    const persistedText = readFileSync(
      join(channelsRoot, "slack", "accounts.json"),
      "utf-8",
    );
    expect(persistedText).not.toContain("xoxb-secret");
    expect(persistedText).not.toContain("xoxb-first");
    expect(persistedText).not.toContain("xapp-first");
    expect(persistedText).not.toContain("xapp-second");
    expect(JSON.parse(persistedText).accounts[0]).toMatchObject({
      __letta_secret_refs: {
        botToken: true,
        appToken: true,
      },
    });

    clearChannelAccountStores();
    const rehydrated = (await getChannelAccountWithSecrets(
      "slack",
      "slack-account",
    )) as SlackChannelAccount | null;
    expect(rehydrated?.botToken).toBe("xoxb-secret");
    expect(rehydrated?.appToken).toBe("xapp-second");
  });

  test("reports the original write error together with rollback failures", async () => {
    __setActiveChannelCredentialsStoreModeForTests("keyring");
    await upsertChannelAccountWithSecrets("slack", makeSlackAccount());

    const botTokenName = buildChannelSecretName(
      "slack",
      "slack-account",
      "botToken",
    );
    const appTokenName = buildChannelSecretName(
      "slack",
      "slack-account",
      "appToken",
    );
    __setChannelSecretStoreOverrideForTests({
      get: async (name) => secrets.get(name) ?? null,
      set: async (name, value) => {
        if (name === appTokenName && value === "xapp-new") {
          throw new Error("second keyring write failed");
        }
        if (name === botTokenName && value === "xoxb-secret") {
          throw new Error("bot token rollback failed");
        }
        secrets.set(name, value);
      },
      delete: async (name) => secrets.delete(name),
    });

    try {
      await upsertChannelAccountWithSecrets("slack", {
        ...makeSlackAccount(),
        botToken: "xoxb-new",
        appToken: "xapp-new",
      });
      throw new Error("Expected secure account update to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect(error).toHaveProperty(
        "message",
        expect.stringContaining("second keyring write failed"),
      );
      expect(error).toHaveProperty(
        "message",
        expect.stringContaining("Failed to restore botToken"),
      );
      expect((error as AggregateError).errors[0]).toHaveProperty(
        "message",
        "second keyring write failed",
      );
    }
  });

  test("sync saves keep hydrated keyring credentials redacted", async () => {
    __setActiveChannelCredentialsStoreModeForTests("keyring");

    await upsertChannelAccountWithSecrets("slack", makeSlackAccount());
    clearChannelAccountStores();
    const hydrated = (await getChannelAccountWithSecrets(
      "slack",
      "slack-account",
    )) as SlackChannelAccount | null;
    if (!hydrated) {
      throw new Error("Expected hydrated Slack account");
    }

    upsertChannelAccount("slack", { ...hydrated, enabled: false });

    const persistedText = readFileSync(
      join(channelsRoot, "slack", "accounts.json"),
      "utf-8",
    );
    expect(persistedText).not.toContain("xoxb-secret");
    expect(persistedText).not.toContain("xapp-secret");
    expect(persistedText).toContain("__letta_secret_refs");
  });

  test("failed multi-secret create removes newly written keyring values", async () => {
    __setActiveChannelCredentialsStoreModeForTests("keyring");
    const appTokenName = buildChannelSecretName(
      "slack",
      "slack-account",
      "appToken",
    );
    __setChannelSecretStoreOverrideForTests({
      get: async (name) => secrets.get(name) ?? null,
      set: async (name, value) => {
        if (name === appTokenName) {
          throw new Error("keyring rejected second secret");
        }
        secrets.set(name, value);
      },
      delete: async (name) => secrets.delete(name),
    });

    await expect(
      upsertChannelAccountWithSecrets("slack", makeSlackAccount()),
    ).rejects.toThrow("keyring rejected second secret");

    expect(secrets.size).toBe(0);
    expect(existsSync(join(channelsRoot, "slack", "accounts.json"))).toBe(
      false,
    );
  });

  test("sync keyring save keeps plaintext until secrets are persisted", () => {
    __setActiveChannelCredentialsStoreModeForTests("keyring");

    upsertChannelAccount("slack", makeSlackAccount());

    const persistedText = readFileSync(
      join(channelsRoot, "slack", "accounts.json"),
      "utf-8",
    );
    expect(persistedText).toContain("xoxb-secret");
    expect(persistedText).toContain("xapp-secret");
    expect(persistedText).not.toContain("__letta_secret_refs");
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

  test("keyring mode preserves unresolved Telegram token refs on restart", async () => {
    __setActiveChannelCredentialsStoreModeForTests("keyring");
    mkdirSync(join(channelsRoot, "telegram"), { recursive: true });
    const accountsPath = join(channelsRoot, "telegram", "accounts.json");
    writeFileSync(
      accountsPath,
      `${JSON.stringify(
        { accounts: [makeTelegramAccountWithSecretRef()] },
        null,
        2,
      )}\n`,
    );
    const beforeHydration = readFileSync(accountsPath, "utf-8");

    await hydrateChannelAccountSecrets("telegram");

    expect(readFileSync(accountsPath, "utf-8")).toBe(beforeHydration);
    const persisted = readAccountsFile(channelsRoot, "telegram") as {
      accounts: Array<Record<string, unknown>>;
    };
    expect(persisted.accounts[0]).toMatchObject({
      __letta_secret_refs: {
        token: true,
      },
    });
    expect(persisted.accounts[0]).not.toHaveProperty("token", "");

    const hydrated = (await getChannelAccountWithSecrets(
      "telegram",
      "telegram-account",
    )) as TelegramChannelAccount | null;
    expect(hydrated?.token).toBe("__letta_channel_secret_present__");
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
});
