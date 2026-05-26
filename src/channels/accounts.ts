import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { migratePermissionMode } from "@/permissions/mode";
import { isRecord } from "@/utils/type-guards";
import {
  getChannelAccountsPath,
  getChannelDir,
  readChannelConfig,
} from "./config";
import type {
  ChannelAccount,
  ChannelDefaultPermissionMode,
  CustomChannelAccount,
  DiscordChannelAccount,
  SlackChannelAccount,
  SupportedChannelId,
  TelegramChannelAccount,
  WhatsAppChannelAccount,
} from "./types";
import {
  isCustomChannelAccount,
  isDiscordChannelAccount,
  isFirstPartyChannelId,
  isSlackChannelAccount,
  isTelegramChannelAccount,
  isWhatsAppChannelAccount,
} from "./types";

/**
 * Known snake_case → camelCase key mappings for migration.
 * When both forms exist on a loaded account, snake_case wins and a
 * warning is logged. Only the camelCase form is kept in the runtime
 * account object; the canonicalized snake_case form is emitted on save.
 */
const SNAKE_TO_CAMEL: Record<string, string> = {
  allowed_channels: "allowedChannels",
  auto_thread_on_mention: "autoThreadOnMention",
  acknowledge_message_reaction: "acknowledgeMessageReaction",
  group_mode: "groupMode",
  inbound_debounce_ms: "inboundDebounceMs",
  remove_stale_routes: "removeStaleRoutes",
  thread_policy_by_channel: "threadPolicyByChannel",
  transcribe_voice: "transcribeVoice",
};

let warnedAboutDualKeys = false;

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

  if (isTelegramChannelAccount(account)) {
    (cloned as TelegramChannelAccount).binding = { ...account.binding };
  }

  if (isDiscordChannelAccount(account) && account.allowedChannels) {
    (cloned as DiscordChannelAccount).allowedChannels = Array.isArray(
      account.allowedChannels,
    )
      ? [...account.allowedChannels]
      : { ...account.allowedChannels };
  }

  if (isWhatsAppChannelAccount(account)) {
    (cloned as WhatsAppChannelAccount).allowedGroups = [
      ...(account.allowedGroups ?? []),
    ];
    (cloned as WhatsAppChannelAccount).mentionPatterns = [
      ...(account.mentionPatterns ?? []),
    ];
  }

  if ("config" in account) {
    (cloned as CustomChannelAccount).config = { ...account.config };
  }

  return cloned;
}

function normalizeLoadedAccount<T extends ChannelAccount>(account: T): T {
  const next = cloneAccount(account);

  // ── Key migration: accept snake_case keys from accounts.json ──
  // Runtime code uses camelCase throughout. On read, accept both forms;
  // if both exist, snake_case wins (log warning once).
  const raw = account as unknown as Record<string, unknown>;
  for (const [snakeKey, camelKey] of Object.entries(SNAKE_TO_CAMEL)) {
    const hasSnake = snakeKey in raw;
    const hasCamel = camelKey in raw;
    if (hasSnake && hasCamel) {
      if (!warnedAboutDualKeys) {
        warnedAboutDualKeys = true;
        console.warn(
          `[accounts] Both "${snakeKey}" and "${camelKey}" found in loaded account. "${snakeKey}" takes precedence. Remove "${camelKey}" to silence this warning.`,
        );
      }
      (next as unknown as Record<string, unknown>)[camelKey] = (
        next as unknown as Record<string, unknown>
      )[snakeKey];
      continue;
    }
    if (hasSnake && !hasCamel) {
      (next as unknown as Record<string, unknown>)[camelKey] = raw[snakeKey];
    }
    // hasCamel && !hasSnake → already on the object, nothing to do
  }

  // Both the "custom" first-party channel and all user-installed channels use
  // the generic `config: Record<string, unknown>` shape, so make sure that
  // field is present and well-formed before downstream code reads it.
  if (isCustomChannelAccount(next) || !isFirstPartyChannelId(next.channel)) {
    (next as CustomChannelAccount).config = isRecord(
      (next as Partial<CustomChannelAccount>).config,
    )
      ? { ...(next as CustomChannelAccount).config }
      : {};
  }
  if (
    (isTelegramChannelAccount(next) &&
      (next.displayName === "Telegram bot" ||
        next.displayName === "Migrated Telegram bot")) ||
    (isSlackChannelAccount(next) &&
      (next.displayName === "Slack app" ||
        next.displayName === "Migrated Slack app")) ||
    (isDiscordChannelAccount(next) &&
      (next.displayName === "Discord bot" ||
        next.displayName === "Migrated Discord bot")) ||
    (isWhatsAppChannelAccount(next) && next.displayName === "WhatsApp")
  ) {
    next.displayName = undefined;
  }
  if (isSlackChannelAccount(next)) {
    const migrated = migratePermissionMode(
      (next as SlackChannelAccount).defaultPermissionMode ?? "standard",
    );
    (next as SlackChannelAccount).defaultPermissionMode =
      (migrated as ChannelDefaultPermissionMode | null) ?? "standard";
  }
  if (isDiscordChannelAccount(next)) {
    const migrated = migratePermissionMode(
      (next as DiscordChannelAccount).defaultPermissionMode ?? "standard",
    );
    (next as DiscordChannelAccount).defaultPermissionMode =
      (migrated as ChannelDefaultPermissionMode | null) ?? "standard";

    // Compatibility migration: existing accounts created before this field was
    // persisted auto-threaded on mentions by default. Keep that behavior for
    // accounts that lack an explicit setting, while new accounts write false.
    if (!("auto_thread_on_mention" in raw) && !("autoThreadOnMention" in raw)) {
      (next as DiscordChannelAccount).autoThreadOnMention = true;
    }
  }
  if (isWhatsAppChannelAccount(next)) {
    next.selfChatMode = next.selfChatMode !== false;
    next.groupMode = next.groupMode ?? "disabled";
    next.allowedGroups = [...(next.allowedGroups ?? [])];
    next.mentionPatterns = [...(next.mentionPatterns ?? [])];
    next.downloadMedia = next.downloadMedia === true;
    next.transcribeVoice = next.transcribeVoice === true;
  }
  return next;
}

function makeDefaultLegacyAccount(
  channelId: SupportedChannelId,
): ChannelAccount {
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
      transcribeVoice: config.transcribeVoice === true,
      binding: {
        agentId: null,
        conversationId: null,
      },
      createdAt: now,
      updatedAt: now,
    };
  }

  if (config.channel === "discord") {
    return {
      channel: "discord",
      accountId: LEGACY_CHANNEL_ACCOUNT_ID,
      enabled: config.enabled,
      token: config.token,
      dmPolicy: config.dmPolicy,
      allowedUsers: [...config.allowedUsers],
      allowedChannels: config.allowedChannels
        ? Array.isArray(config.allowedChannels)
          ? [...config.allowedChannels]
          : { ...config.allowedChannels }
        : undefined,
      autoThreadOnMention: config.autoThreadOnMention ?? true,
      threadPolicyByChannel: config.threadPolicyByChannel,
      agentId: null,
      defaultPermissionMode: config.defaultPermissionMode ?? "standard",
      createdAt: now,
      updatedAt: now,
    };
  }

  if (config.channel === "whatsapp") {
    return {
      channel: "whatsapp",
      accountId: LEGACY_CHANNEL_ACCOUNT_ID,
      enabled: config.enabled,
      dmPolicy: config.dmPolicy,
      allowedUsers: [...config.allowedUsers],
      agentId: config.agentId,
      selfChatMode: config.selfChatMode !== false,
      groupMode: config.groupMode ?? "disabled",
      allowedGroups: config.allowedGroups ? [...config.allowedGroups] : [],
      mentionPatterns: config.mentionPatterns
        ? [...config.mentionPatterns]
        : [],
      transcribeVoice: config.transcribeVoice === true,
      downloadMedia: config.downloadMedia === true,
      mediaMaxBytes: config.mediaMaxBytes,
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
    defaultPermissionMode: "standard",
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

  if (
    channelId === "telegram" ||
    channelId === "slack" ||
    channelId === "discord" ||
    channelId === "whatsapp"
  ) {
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
  const writeAccounts = store.accounts.map((account) => {
    const cloned = cloneAccount(account);
    // Canonicalize: convert camelCase keys to snake_case for storage
    for (const [snakeKey, camelKey] of Object.entries(SNAKE_TO_CAMEL)) {
      const value = (cloned as unknown as Record<string, unknown>)[camelKey];
      // Remove camelCase key
      delete (cloned as unknown as Record<string, unknown>)[camelKey];
      // Set snake_case key (only if value is not undefined — omit absent fields)
      if (value !== undefined) {
        (cloned as unknown as Record<string, unknown>)[snakeKey] = value;
      }
    }
    return cloned;
  });

  if (saveAccountsOverride) {
    saveAccountsOverride(
      channelId,
      writeAccounts.map((account) => cloneAccount(account)),
    );
    return;
  }

  const dir = getChannelDir(channelId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    getChannelAccountsPath(channelId),
    `${JSON.stringify({ accounts: writeAccounts }, null, 2)}\n`,
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
  warnedAboutDualKeys = false;
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
