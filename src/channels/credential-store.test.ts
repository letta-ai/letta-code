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

function makeTelegramAccount(): TelegramChannelAccount {
  return {
    channel: "telegram",
    accountId: "telegram-account",
    enabled: true,
    token: "telegram-secret",
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

  test("missing keyring reads preserve Telegram secret refs", async () => {
    __setActiveChannelCredentialsStoreModeForTests("keyring");

    await upsertChannelAccountWithSecrets("telegram", makeTelegramAccount());
    await flushPendingChannelSecretWrites();

    secrets.clear();
    clearChannelAccountStores();

    await hydrateChannelAccountSecrets("telegram");

    const persisted = readAccountsFile(channelsRoot, "telegram") as {
      accounts: Array<Record<string, unknown>>;
    };
    expect(persisted.accounts[0]).toMatchObject({
      __letta_secret_refs: {
        token: true,
      },
    });
    expect(persisted.accounts[0]).not.toHaveProperty("token", "");
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
