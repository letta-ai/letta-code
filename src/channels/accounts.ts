import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  getChannelAccountsPath,
  getChannelDir,
  readChannelConfig,
} from "./config";
import type {
  ChannelAccount,
  SlackChannelAccount,
  SupportedChannelId,
  TelegramChannelAccount,
} from "./types";

interface ChannelAccountStore {
  accounts: ChannelAccount[];
}

export const LEGACY_CHANNEL_ACCOUNT_ID = "__legacy_migrated__";

const stores = new Map<string, ChannelAccountStore>();

let loadAccountsOverride:
  | ((channelId: string) => ChannelAccount[] | null)
  | null = null;
let saveAccountsOverride:
  | ((channelId: string, accounts: ChannelAccount[]) => void)
  | null = null;

function cloneAccount<T extends ChannelAccount>(account: T): T {
  const cloned = {
    ...account,
    allowedUsers: [...account.allowedUsers],
  } as T;

  if (account.channel === "telegram") {
    (cloned as TelegramChannelAccount).binding = { ...account.binding };
  }

  return cloned;
}

function normalizeLoadedAccount<T extends ChannelAccount>(account: T): T {
  const next = cloneAccount(account);
  if (
    (next.channel === "telegram" &&
      (next.displayName === "Telegram bot" ||
        next.displayName === "Migrated Telegram bot")) ||
    (next.channel === "slack" &&
      (next.displayName === "Slack app" ||
        next.displayName === "Migrated Slack app"))
  ) {
    next.displayName = undefined;
  }
  return next;
}

function makeDefaultLegacyAccount(
  channelId: SupportedChannelId,
): TelegramChannelAccount | SlackChannelAccount {
  const config = readChannelConfig(channelId);
  const now = new Date().toISOString();

  if (!config) {
    throw new Error(`Missing legacy config for ${channelId}`);
  }

  if (config.channel === "telegram") {
    return {
      channel: "telegram",
      accountId: LEGACY_CHANNEL_ACCOUNT_ID,
      enabled: config.enabled,
      token: config.token,
      dmPolicy: config.dmPolicy,
      allowedUsers: [...config.allowedUsers],
      binding: {
        agentId: null,
        conversationId: null,
      },
      createdAt: now,
      updatedAt: now,
    };
  }

  return {
    channel: "slack",
    accountId: LEGACY_CHANNEL_ACCOUNT_ID,
    enabled: config.enabled,
    mode: config.mode,
    botToken: config.botToken,
    appToken: config.appToken,
    dmPolicy: config.dmPolicy,
    allowedUsers: [...config.allowedUsers],
    agentId: null,
    createdAt: now,
    updatedAt: now,
  };
}

function getStore(channelId: string): ChannelAccountStore {
  let store = stores.get(channelId);
  if (!store) {
    loadChannelAccounts(channelId);
    store = stores.get(channelId);
  }

  if (!store) {
    store = { accounts: [] };
    stores.set(channelId, store);
  }

  return store;
}

export function loadChannelAccounts(channelId: string): void {
  if (loadAccountsOverride) {
    stores.set(channelId, {
      accounts: (loadAccountsOverride(channelId) ?? []).map((account) =>
        normalizeLoadedAccount(account),
      ),
    });
    return;
  }

  const path = getChannelAccountsPath(channelId);
  if (existsSync(path)) {
    try {
      const text = readFileSync(path, "utf-8");
      const parsed = JSON.parse(text) as Partial<ChannelAccountStore>;
      stores.set(channelId, {
        accounts: (parsed.accounts ?? []).map((account) =>
          normalizeLoadedAccount(account),
        ),
      });
      return;
    } catch {
      stores.set(channelId, { accounts: [] });
      return;
    }
  }

  if (channelId === "telegram" || channelId === "slack") {
    const legacyConfig = readChannelConfig(channelId);
    if (legacyConfig) {
      const migratedAccounts = [makeDefaultLegacyAccount(channelId)];
      stores.set(channelId, {
        accounts: migratedAccounts,
      });
      saveChannelAccounts(channelId);
      return;
    }
  }

  stores.set(channelId, { accounts: [] });
}

function saveChannelAccounts(channelId: string): void {
  const store = getStore(channelId);
  if (saveAccountsOverride) {
    saveAccountsOverride(
      channelId,
      store.accounts.map((account) => cloneAccount(account)),
    );
    return;
  }

  const dir = getChannelDir(channelId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    getChannelAccountsPath(channelId),
    `${JSON.stringify({ accounts: store.accounts }, null, 2)}\n`,
    "utf-8",
  );
}

export function listChannelAccounts(channelId: string): ChannelAccount[] {
  return getStore(channelId).accounts.map((account) => cloneAccount(account));
}

export function getChannelAccount(
  channelId: string,
  accountId: string,
): ChannelAccount | null {
  const account = getStore(channelId).accounts.find(
    (entry) => entry.accountId === accountId,
  );
  return account ? cloneAccount(account) : null;
}

export function upsertChannelAccount(
  channelId: string,
  account: ChannelAccount,
): ChannelAccount {
  const store = getStore(channelId);
  const next = cloneAccount(account);
  const index = store.accounts.findIndex(
    (entry) => entry.accountId === account.accountId,
  );
  if (index >= 0) {
    store.accounts[index] = next;
  } else {
    store.accounts.push(next);
  }
  saveChannelAccounts(channelId);
  return cloneAccount(next);
}

export function removeChannelAccount(
  channelId: string,
  accountId: string,
): boolean {
  const store = getStore(channelId);
  const nextAccounts = store.accounts.filter(
    (entry) => entry.accountId !== accountId,
  );
  if (nextAccounts.length === store.accounts.length) {
    return false;
  }
  store.accounts = nextAccounts;
  saveChannelAccounts(channelId);
  return true;
}

export function clearChannelAccountStores(): void {
  stores.clear();
}

export function __testOverrideLoadChannelAccounts(
  fn: ((channelId: string) => ChannelAccount[] | null) | null,
): void {
  loadAccountsOverride = fn;
}

export function __testOverrideSaveChannelAccounts(
  fn: ((channelId: string, accounts: ChannelAccount[]) => void) | null,
): void {
  saveAccountsOverride = fn;
}
