import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { migratePermissionMode } from "@/permissions/mode";
import { isRecord } from "@/utils/type-guards";
import {
  getChannelAccountsPath,
  getChannelDir,
  readChannelConfig,
} from "./config";
import {
  deleteChannelSecret,
  getActiveChannelCredentialsStoreMode,
  getCachedChannelCredentialsStoreMode,
  getChannelSecret,
  setChannelSecret,
} from "./credential-store";
import type {
  ChannelAccount,
  ChannelDefaultPermissionMode,
  CustomChannelAccount,
  DiscordChannelAccount,
  SignalChannelAccount,
  SlackChannelAccount,
  SupportedChannelId,
  TelegramChannelAccount,
  WhatsAppChannelAccount,
} from "./types";
import {
  DEFAULT_SLACK_PERMISSION_MODE,
  isCustomChannelAccount,
  isDiscordChannelAccount,
  isFirstPartyChannelId,
  isSignalChannelAccount,
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
  account_uuid: "accountUuid",
  allowed_channels: "allowedChannels",
  allowed_groups: "allowedGroups",
  auto_thread_on_mention: "autoThreadOnMention",
  base_url: "baseUrl",
  acknowledge_message_reaction: "acknowledgeMessageReaction",
  group_mode: "groupMode",
  inbound_debounce_ms: "inboundDebounceMs",
  listen_mode: "listenMode",
  media_max_bytes: "mediaMaxBytes",
  mention_patterns: "mentionPatterns",
  recipient_aliases: "recipientAliases",
  remove_stale_routes: "removeStaleRoutes",
  rich_draft_streaming: "richDraftStreaming",
  rich_private_chat_default: "richPrivateChatDefault",
  show_completed_reaction: "showCompletedReaction",
  thread_policy_by_channel: "threadPolicyByChannel",
  transcribe_voice: "transcribeVoice",
  download_media: "downloadMedia",
};

let warnedAboutDualKeys = false;

interface ChannelAccountStore {
  accounts: ChannelAccount[];
}

export const LEGACY_CHANNEL_ACCOUNT_ID = "__legacy_migrated__";

const stores = new Map<string, ChannelAccountStore>();
const CHANNEL_SECRET_REFS_KEY = "__letta_secret_refs";
const SECRET_PRESENT_PLACEHOLDER = "__letta_channel_secret_present__";
const pendingSecretWrites: Promise<unknown>[] = [];

type ChannelAccountWithSecretRefs = ChannelAccount & {
  [CHANNEL_SECRET_REFS_KEY]?: Record<string, true>;
};

let loadAccountsOverride:
  | ((channelId: string) => ChannelAccount[] | null)
  | null = null;
let saveAccountsOverride:
  | ((channelId: string, accounts: ChannelAccount[]) => void)
  | null = null;

function isSecretPlaceholder(value: unknown): boolean {
  return value === SECRET_PRESENT_PLACEHOLDER;
}

function getSecretFieldPaths(account: ChannelAccount): string[] {
  if (isSlackChannelAccount(account)) {
    return ["botToken", "appToken"];
  }
  if (isTelegramChannelAccount(account) || isDiscordChannelAccount(account)) {
    return ["token"];
  }
  if (
    isCustomChannelAccount(account) ||
    !isFirstPartyChannelId(account.channel)
  ) {
    return ["config.bot_token", "config.auth"];
  }
  return [];
}

function getSecretValueFromAccount(
  account: ChannelAccount,
  fieldPath: string,
): unknown {
  if (fieldPath.startsWith("config.")) {
    const key = fieldPath.slice("config.".length);
    return (account as CustomChannelAccount).config?.[key];
  }
  return (account as unknown as Record<string, unknown>)[fieldPath];
}

function setSecretValueOnAccount(
  account: ChannelAccount,
  fieldPath: string,
  value: string,
): void {
  if (fieldPath.startsWith("config.")) {
    const key = fieldPath.slice("config.".length);
    const customAccount = account as CustomChannelAccount;
    customAccount.config = { ...(customAccount.config ?? {}), [key]: value };
    return;
  }
  (account as unknown as Record<string, unknown>)[fieldPath] = value;
}

function deleteSecretValueFromAccount(
  account: ChannelAccount,
  fieldPath: string,
): void {
  if (fieldPath.startsWith("config.")) {
    const key = fieldPath.slice("config.".length);
    delete (account as CustomChannelAccount).config?.[key];
    return;
  }
  delete (account as unknown as Record<string, unknown>)[fieldPath];
}

function getSecretRefs(account: ChannelAccount): Record<string, true> {
  return {
    ...((account as ChannelAccountWithSecretRefs)[CHANNEL_SECRET_REFS_KEY] ??
      {}),
  };
}

function markSecretRef(account: ChannelAccount, fieldPath: string): void {
  (account as ChannelAccountWithSecretRefs)[CHANNEL_SECRET_REFS_KEY] = {
    ...getSecretRefs(account),
    [fieldPath]: true,
  };
}

function unmarkSecretRef(account: ChannelAccount, fieldPath: string): void {
  const refs = getSecretRefs(account);
  delete refs[fieldPath];
  if (Object.keys(refs).length === 0) {
    delete (account as ChannelAccountWithSecretRefs)[CHANNEL_SECRET_REFS_KEY];
    return;
  }
  (account as ChannelAccountWithSecretRefs)[CHANNEL_SECRET_REFS_KEY] = refs;
}

function applySecretPlaceholders(account: ChannelAccount): void {
  const refs = getSecretRefs(account);
  for (const fieldPath of Object.keys(refs)) {
    const current = getSecretValueFromAccount(account, fieldPath);
    if (typeof current !== "string" || current.length === 0) {
      setSecretValueOnAccount(account, fieldPath, SECRET_PRESENT_PLACEHOLDER);
    }
  }
}

function queueSecretWrite(promise: Promise<unknown>): void {
  pendingSecretWrites.push(
    promise.catch(() => {
      // Best-effort background secret persistence. Foreground commands that
      // need to validate credentials surface errors explicitly; detached secret
      // writes should not spam startup logs or crash the process.
    }),
  );
}

function prepareAccountForStorage(account: ChannelAccount): ChannelAccount {
  const cloned = cloneAccount(account) as ChannelAccountWithSecretRefs;
  if (getCachedChannelCredentialsStoreMode() !== "keyring") {
    delete cloned[CHANNEL_SECRET_REFS_KEY];
    return cloned;
  }

  delete cloned[CHANNEL_SECRET_REFS_KEY];
  for (const fieldPath of getSecretFieldPaths(cloned)) {
    const value = getSecretValueFromAccount(cloned, fieldPath);
    if (typeof value === "string" && value.trim().length > 0) {
      markSecretRef(cloned, fieldPath);
      if (!isSecretPlaceholder(value)) {
        queueSecretWrite(
          setChannelSecret(cloned.channel, cloned.accountId, fieldPath, value),
        );
      }
      deleteSecretValueFromAccount(cloned, fieldPath);
    }
  }

  return cloned;
}

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

  if (isSignalChannelAccount(account)) {
    (cloned as SignalChannelAccount).allowedGroups = [
      ...(account.allowedGroups ?? []),
    ];
    (cloned as SignalChannelAccount).mentionPatterns = [
      ...(account.mentionPatterns ?? []),
    ];
    (cloned as SignalChannelAccount).recipientAliases = {
      ...(account.recipientAliases ?? {}),
    };
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
    (isWhatsAppChannelAccount(next) && next.displayName === "WhatsApp") ||
    (isSignalChannelAccount(next) && next.displayName === "Signal")
  ) {
    next.displayName = undefined;
  }
  if (isSlackChannelAccount(next)) {
    const migrated = migratePermissionMode(
      (next as SlackChannelAccount).defaultPermissionMode ??
        DEFAULT_SLACK_PERMISSION_MODE,
    );
    (next as SlackChannelAccount).defaultPermissionMode =
      (migrated as ChannelDefaultPermissionMode | null) ??
      DEFAULT_SLACK_PERMISSION_MODE;
    (next as SlackChannelAccount).transcribeVoice =
      (next as SlackChannelAccount).transcribeVoice === true;
    (next as SlackChannelAccount).showCompletedReaction =
      (next as SlackChannelAccount).showCompletedReaction !== false;
    (next as SlackChannelAccount).listenMode =
      (next as SlackChannelAccount).listenMode === true;
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
  if (isSignalChannelAccount(next)) {
    next.baseUrl = next.baseUrl ?? "";
    next.selfChatMode = next.selfChatMode === true;
    next.groupMode = next.groupMode ?? "disabled";
    next.allowedGroups = [...(next.allowedGroups ?? [])];
    next.mentionPatterns = [...(next.mentionPatterns ?? [])];
    next.recipientAliases = { ...(next.recipientAliases ?? {}) };
    next.downloadMedia = next.downloadMedia !== false;
  }
  if (isTelegramChannelAccount(next)) {
    next.richPrivateChatDefault = next.richPrivateChatDefault !== false;
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
      richPrivateChatDefault: config.richPrivateChatDefault !== false,
      richDraftStreaming: config.richDraftStreaming === true,
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

  if (config.channel === "signal") {
    return {
      channel: "signal",
      accountId: LEGACY_CHANNEL_ACCOUNT_ID,
      enabled: config.enabled,
      baseUrl: config.baseUrl,
      account: config.account,
      accountUuid: config.accountUuid,
      dmPolicy: config.dmPolicy,
      allowedUsers: [...config.allowedUsers],
      agentId: config.agentId,
      selfChatMode: config.selfChatMode === true,
      groupMode: config.groupMode ?? "disabled",
      allowedGroups: config.allowedGroups ? [...config.allowedGroups] : [],
      mentionPatterns: config.mentionPatterns
        ? [...config.mentionPatterns]
        : [],
      recipientAliases: { ...(config.recipientAliases ?? {}) },
      downloadMedia: config.downloadMedia !== false,
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
    defaultPermissionMode: DEFAULT_SLACK_PERMISSION_MODE,
    transcribeVoice: config.transcribeVoice === true,
    showCompletedReaction: config.showCompletedReaction !== false,
    listenMode: config.listenMode === true,
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
        accounts: (parsed.accounts ?? []).map((account) => {
          const normalized = normalizeLoadedAccount(account);
          applySecretPlaceholders(normalized);
          return normalized;
        }),
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
    channelId === "whatsapp" ||
    channelId === "signal"
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
    const cloned = prepareAccountForStorage(account);
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

export async function flushPendingChannelSecretWrites(): Promise<void> {
  while (pendingSecretWrites.length > 0) {
    const writes = pendingSecretWrites.splice(0, pendingSecretWrites.length);
    await Promise.all(writes);
  }
}

export async function hydrateChannelAccountSecrets(
  channelId: string,
): Promise<void> {
  const mode = await getActiveChannelCredentialsStoreMode();
  const store = getStore(channelId);
  if (mode !== "keyring") {
    return;
  }

  let migratedPlaintextSecrets = false;
  let removedMissingSecretRefs = false;

  for (const account of store.accounts) {
    for (const fieldPath of getSecretFieldPaths(account)) {
      const currentValue = getSecretValueFromAccount(account, fieldPath);
      if (typeof currentValue === "string" && currentValue.trim().length > 0) {
        markSecretRef(account, fieldPath);
        if (!isSecretPlaceholder(currentValue)) {
          await setChannelSecret(
            account.channel,
            account.accountId,
            fieldPath,
            currentValue,
          );
          migratedPlaintextSecrets = true;
        } else {
          const storedValue = await getChannelSecret(
            account.channel,
            account.accountId,
            fieldPath,
          );
          if (storedValue) {
            setSecretValueOnAccount(account, fieldPath, storedValue);
          } else {
            unmarkSecretRef(account, fieldPath);
            setSecretValueOnAccount(account, fieldPath, "");
            removedMissingSecretRefs = true;
          }
        }
      }
    }
  }

  if (migratedPlaintextSecrets || removedMissingSecretRefs) {
    saveChannelAccounts(channelId);
    await flushPendingChannelSecretWrites();
  }
}

export function listChannelAccounts(channelId: string): ChannelAccount[] {
  return getStore(channelId).accounts.map((account) => cloneAccount(account));
}

export async function listChannelAccountsWithSecrets(
  channelId: string,
): Promise<ChannelAccount[]> {
  await hydrateChannelAccountSecrets(channelId);
  return listChannelAccounts(channelId);
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

export async function getChannelAccountWithSecrets(
  channelId: string,
  accountId: string,
): Promise<ChannelAccount | null> {
  await hydrateChannelAccountSecrets(channelId);
  return getChannelAccount(channelId, accountId);
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

export async function upsertChannelAccountWithSecrets(
  channelId: string,
  account: ChannelAccount,
): Promise<ChannelAccount> {
  await getActiveChannelCredentialsStoreMode();
  const next = upsertChannelAccount(channelId, account);
  await flushPendingChannelSecretWrites();
  return next;
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

export async function removeChannelAccountWithSecrets(
  channelId: string,
  accountId: string,
): Promise<boolean> {
  await hydrateChannelAccountSecrets(channelId);
  const account = getChannelAccount(channelId, accountId);
  if (account && getCachedChannelCredentialsStoreMode() === "keyring") {
    await Promise.all(
      getSecretFieldPaths(account).map((fieldPath) =>
        deleteChannelSecret(channelId, accountId, fieldPath),
      ),
    );
  }
  return removeChannelAccount(channelId, accountId);
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
