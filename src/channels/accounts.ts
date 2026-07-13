import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { migratePermissionMode } from "@/permissions/mode";
import { isRecord } from "@/utils/type-guards";
import {
  buildRollbackError,
  captureChannelSecretSnapshots,
  deleteForegroundAccountSecrets,
  getMutationSecretFieldPaths,
  restoreChannelSecretSnapshots,
  writeForegroundAccountSecrets,
} from "./account-secret-transactions";
import {
  getChannelAccountsPath,
  getChannelDir,
  readChannelConfig,
} from "./config";
import {
  getActiveChannelCredentialsStoreMode,
  getCachedChannelCredentialsStoreMode,
  getChannelSecret,
  setChannelSecret,
} from "./credential-store";
import {
  CHANNEL_SECRET_REFS_KEY,
  configSecretFieldPathToKey,
  getAccountSecretFieldPaths,
  isNonEmptyString,
  isSecretPlaceholderValue,
  SECRET_PRESENT_PLACEHOLDER,
} from "./credential-utils";
import { makeDefaultLegacyAccount } from "./legacy-account";
import type {
  ChannelAccount,
  ChannelDefaultPermissionMode,
  CustomChannelAccount,
  DiscordChannelAccount,
  SignalChannelAccount,
  SlackChannelAccount,
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

type PendingChannelSecretWrite = {
  channelId: string;
  accountId: string;
  fieldPath: string;
  promise: Promise<unknown>;
};

type PendingChannelSecretWriteFilter = {
  channelId?: string;
  accountId?: string;
};

type PrepareAccountForStorageOptions = {
  queueSecretWrites?: boolean;
};

let pendingSecretWrites: PendingChannelSecretWrite[] = [];

export class ChannelCredentialHydrationError extends Error {
  constructor(
    channelId: string,
    accountId: string,
    fieldPath: string,
    cause?: unknown,
  ) {
    const detail =
      cause instanceof Error && cause.message.trim().length > 0
        ? ` ${cause.message}`
        : "";
    super(
      `Could not load ${channelId}/${accountId}/${fieldPath} from the channel credential store.${detail} Re-add this channel credential or set LETTA_CHANNEL_CREDENTIALS_STORE=file and update the account before restarting the channel listener. The saved secret reference was preserved.`,
      { cause },
    );
    this.name = "ChannelCredentialHydrationError";
  }
}

export class ChannelCredentialPersistenceError extends Error {
  constructor(channelId: string, accountId: string, fieldPath: string) {
    super(
      `Cannot save ${channelId}/${accountId}/${fieldPath} while the account still references a secure-store secret that is not loaded. Re-add this channel credential or switch back to LETTA_CHANNEL_CREDENTIALS_STORE=keyring before updating the account. The saved secret reference was preserved.`,
    );
    this.name = "ChannelCredentialPersistenceError";
  }
}

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
  return isSecretPlaceholderValue(value);
}

function getSecretValueFromAccount(
  account: ChannelAccount,
  fieldPath: string,
): unknown {
  const configKey = configSecretFieldPathToKey(fieldPath);
  if (configKey) {
    return (account as CustomChannelAccount).config?.[configKey];
  }
  return (account as unknown as Record<string, unknown>)[fieldPath];
}

function setSecretValueOnAccount(
  account: ChannelAccount,
  fieldPath: string,
  value: string,
): void {
  const configKey = configSecretFieldPathToKey(fieldPath);
  if (configKey) {
    const customAccount = account as CustomChannelAccount;
    customAccount.config = {
      ...(customAccount.config ?? {}),
      [configKey]: value,
    };
    return;
  }
  (account as unknown as Record<string, unknown>)[fieldPath] = value;
}

function deleteSecretValueFromAccount(
  account: ChannelAccount,
  fieldPath: string,
): void {
  const configKey = configSecretFieldPathToKey(fieldPath);
  if (configKey) {
    delete (account as CustomChannelAccount).config?.[configKey];
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

function applySecretPlaceholders(account: ChannelAccount): void {
  const refs = getSecretRefs(account);
  for (const fieldPath of Object.keys(refs)) {
    const current = getSecretValueFromAccount(account, fieldPath);
    if (typeof current !== "string" || current.length === 0) {
      setSecretValueOnAccount(account, fieldPath, SECRET_PRESENT_PLACEHOLDER);
    }
  }
}

function queueSecretWrite(
  channelId: string,
  accountId: string,
  fieldPath: string,
  promise: Promise<unknown>,
): void {
  // Attach a rejection handler immediately so detached background writes cannot
  // become unhandled rejections. Keep the original promise in the queue so
  // foreground secret-aware operations can await and surface targeted failures.
  promise.catch(() => {});
  pendingSecretWrites.push({ channelId, accountId, fieldPath, promise });
}

function prepareAccountForStorage(
  account: ChannelAccount,
  options: PrepareAccountForStorageOptions = {},
): ChannelAccount {
  const cloned = cloneAccount(account) as ChannelAccountWithSecretRefs;
  const secretFieldPaths = getAccountSecretFieldPaths(cloned);
  if (getCachedChannelCredentialsStoreMode() !== "keyring") {
    const persistedRefPaths = Object.keys(getSecretRefs(cloned));
    for (const fieldPath of new Set([
      ...persistedRefPaths,
      ...secretFieldPaths,
    ])) {
      const value = getSecretValueFromAccount(cloned, fieldPath);
      if (isSecretPlaceholder(value)) {
        throw new ChannelCredentialPersistenceError(
          cloned.channel,
          cloned.accountId,
          fieldPath,
        );
      }
      if (persistedRefPaths.includes(fieldPath) && !isNonEmptyString(value)) {
        throw new ChannelCredentialPersistenceError(
          cloned.channel,
          cloned.accountId,
          fieldPath,
        );
      }
    }
    delete cloned[CHANNEL_SECRET_REFS_KEY];
    return cloned;
  }

  delete cloned[CHANNEL_SECRET_REFS_KEY];
  for (const fieldPath of secretFieldPaths) {
    const value = getSecretValueFromAccount(cloned, fieldPath);
    if (isNonEmptyString(value)) {
      markSecretRef(cloned, fieldPath);
      if (!isSecretPlaceholder(value) && options.queueSecretWrites !== false) {
        queueSecretWrite(
          cloned.channel,
          cloned.accountId,
          fieldPath,
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
    delete (next as unknown as Record<string, unknown>).show_completed_reaction;
    delete (next as unknown as Record<string, unknown>).showCompletedReaction;
    delete (next as unknown as Record<string, unknown>).progress_ui;
    delete (next as unknown as Record<string, unknown>).progressUi;
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
      const migratedAccounts = [
        makeDefaultLegacyAccount(channelId, LEGACY_CHANNEL_ACCOUNT_ID),
      ];
      stores.set(channelId, {
        accounts: migratedAccounts,
      });
      saveChannelAccounts(channelId);
      return;
    }
  }

  stores.set(channelId, { accounts: [] });
}

function saveChannelAccounts(
  channelId: string,
  options: PrepareAccountForStorageOptions = {},
): void {
  const store = getStore(channelId);
  const writeAccounts = store.accounts.map((account) => {
    const cloned = prepareAccountForStorage(account, options);
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

function matchesPendingSecretWrite(
  write: PendingChannelSecretWrite,
  filter: PendingChannelSecretWriteFilter,
): boolean {
  return (
    (!filter.channelId || write.channelId === filter.channelId) &&
    (!filter.accountId || write.accountId === filter.accountId)
  );
}

export async function flushPendingChannelSecretWrites(
  filter: PendingChannelSecretWriteFilter = {},
): Promise<void> {
  while (true) {
    const writes = pendingSecretWrites.filter((write) =>
      matchesPendingSecretWrite(write, filter),
    );
    if (writes.length === 0) {
      return;
    }

    pendingSecretWrites = pendingSecretWrites.filter(
      (write) => !matchesPendingSecretWrite(write, filter),
    );
    const results = await Promise.allSettled(
      writes.map((write) => write.promise),
    );
    const failed = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failed) {
      throw failed.reason;
    }
  }
}

function snapshotStoreAccounts(channelId: string): ChannelAccount[] {
  return getStore(channelId).accounts.map((account) => cloneAccount(account));
}

function restoreStoreAccountsWithoutSecretWrites(
  channelId: string,
  accounts: ChannelAccount[],
): void {
  getStore(channelId).accounts = accounts.map((account) =>
    cloneAccount(account),
  );
  saveChannelAccounts(channelId, { queueSecretWrites: false });
}

async function hydrateAccountSecrets(
  account: ChannelAccount,
): Promise<boolean> {
  let migratedPlaintextSecrets = false;
  const persistedRefs = getSecretRefs(account);

  for (const fieldPath of getAccountSecretFieldPaths(account)) {
    const currentValue = getSecretValueFromAccount(account, fieldPath);
    const hasPersistedRef = persistedRefs[fieldPath] === true;
    if (!hasPersistedRef && !isNonEmptyString(currentValue)) {
      continue;
    }

    markSecretRef(account, fieldPath);
    if (isNonEmptyString(currentValue) && !isSecretPlaceholder(currentValue)) {
      await setChannelSecret(
        account.channel,
        account.accountId,
        fieldPath,
        currentValue,
      );
      migratedPlaintextSecrets = true;
      continue;
    }

    let storedValue: string | null;
    try {
      storedValue = await getChannelSecret(
        account.channel,
        account.accountId,
        fieldPath,
      );
    } catch (error) {
      throw new ChannelCredentialHydrationError(
        account.channel,
        account.accountId,
        fieldPath,
        error,
      );
    }
    if (isNonEmptyString(storedValue)) {
      setSecretValueOnAccount(account, fieldPath, storedValue);
      continue;
    }

    // A persisted ref means the account expects this secret to exist in secure
    // storage. Do not clear the ref or save an empty credential: that destroys
    // the user's only pointer to the original secret.
    throw new ChannelCredentialHydrationError(
      account.channel,
      account.accountId,
      fieldPath,
    );
  }

  return migratedPlaintextSecrets;
}

export async function hydrateChannelAccountSecrets(
  channelId: string,
  accountId?: string,
): Promise<void> {
  const mode = await getActiveChannelCredentialsStoreMode();
  const store = getStore(channelId);
  if (mode !== "keyring") {
    return;
  }

  let migratedPlaintextSecrets = false;
  const accounts = accountId
    ? store.accounts.filter((account) => account.accountId === accountId)
    : store.accounts;

  for (const account of accounts) {
    migratedPlaintextSecrets =
      (await hydrateAccountSecrets(account)) || migratedPlaintextSecrets;
  }

  if (migratedPlaintextSecrets) {
    saveChannelAccounts(channelId);
    await flushPendingChannelSecretWrites(
      accountId ? { channelId, accountId } : { channelId },
    );
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
  await hydrateChannelAccountSecrets(channelId, accountId);
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
  const previous = index >= 0 ? store.accounts[index] : undefined;
  if (index >= 0) {
    store.accounts[index] = next;
  } else {
    store.accounts.push(next);
  }
  try {
    saveChannelAccounts(channelId);
  } catch (error) {
    if (index >= 0 && previous) {
      store.accounts[index] = previous;
    } else {
      store.accounts.pop();
    }
    throw error;
  }
  return cloneAccount(next);
}

export async function upsertChannelAccountWithSecrets(
  channelId: string,
  account: ChannelAccount,
): Promise<ChannelAccount> {
  const mode = await getActiveChannelCredentialsStoreMode();
  if (mode !== "keyring") {
    return upsertChannelAccount(channelId, account);
  }

  const accountId = account.accountId;
  await flushPendingChannelSecretWrites({ channelId, accountId });

  const previousAccounts = snapshotStoreAccounts(channelId);
  const previousAccount =
    previousAccounts.find((entry) => entry.accountId === accountId) ?? null;
  const nextAccount = cloneAccount(account);
  const fieldPaths = getMutationSecretFieldPaths(previousAccount, nextAccount);
  const secretSnapshots = await captureChannelSecretSnapshots(
    channelId,
    accountId,
    previousAccount,
    fieldPaths,
  );

  try {
    await writeForegroundAccountSecrets(nextAccount);
  } catch (error) {
    try {
      await restoreChannelSecretSnapshots(
        channelId,
        accountId,
        secretSnapshots,
      );
    } catch (rollbackError) {
      throw buildRollbackError("Failed to write channel credentials", error, [
        rollbackError,
      ]);
    }
    throw error;
  }

  const nextAccounts = previousAccounts.map((entry) => cloneAccount(entry));
  const index = nextAccounts.findIndex(
    (entry) => entry.accountId === accountId,
  );
  if (index >= 0) {
    nextAccounts[index] = nextAccount;
  } else {
    nextAccounts.push(nextAccount);
  }
  getStore(channelId).accounts = nextAccounts;

  try {
    saveChannelAccounts(channelId, { queueSecretWrites: false });
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    try {
      restoreStoreAccountsWithoutSecretWrites(channelId, previousAccounts);
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    try {
      await restoreChannelSecretSnapshots(
        channelId,
        accountId,
        secretSnapshots,
      );
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    if (rollbackErrors.length > 0) {
      throw buildRollbackError("Failed to save channel account", error, [
        ...rollbackErrors,
      ]);
    }
    throw error;
  }

  return cloneAccount(nextAccount);
}

export function removeChannelAccount(
  channelId: string,
  accountId: string,
): boolean {
  const store = getStore(channelId);
  const previousAccounts = store.accounts.map((account) =>
    cloneAccount(account),
  );
  const nextAccounts = store.accounts.filter(
    (entry) => entry.accountId !== accountId,
  );
  if (nextAccounts.length === store.accounts.length) {
    return false;
  }
  store.accounts = nextAccounts;
  try {
    saveChannelAccounts(channelId);
  } catch (error) {
    store.accounts = previousAccounts;
    throw error;
  }
  return true;
}

export async function removeChannelAccountWithSecrets(
  channelId: string,
  accountId: string,
): Promise<boolean> {
  const mode = await getActiveChannelCredentialsStoreMode();
  const account = getChannelAccount(channelId, accountId);
  if (!account) {
    return false;
  }
  if (mode !== "keyring") {
    return removeChannelAccount(channelId, accountId);
  }

  await flushPendingChannelSecretWrites({ channelId, accountId });
  const previousAccounts = snapshotStoreAccounts(channelId);
  const secretSnapshots = await captureChannelSecretSnapshots(
    channelId,
    accountId,
    account,
    getAccountSecretFieldPaths(account),
  );

  try {
    await deleteForegroundAccountSecrets(channelId, accountId, secretSnapshots);
  } catch (error) {
    try {
      await restoreChannelSecretSnapshots(
        channelId,
        accountId,
        secretSnapshots,
      );
    } catch (rollbackError) {
      throw buildRollbackError("Failed to delete channel credentials", error, [
        rollbackError,
      ]);
    }
    throw error;
  }

  getStore(channelId).accounts = previousAccounts.filter(
    (entry) => entry.accountId !== accountId,
  );
  try {
    saveChannelAccounts(channelId, { queueSecretWrites: false });
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    try {
      restoreStoreAccountsWithoutSecretWrites(channelId, previousAccounts);
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    try {
      await restoreChannelSecretSnapshots(
        channelId,
        accountId,
        secretSnapshots,
      );
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    if (rollbackErrors.length > 0) {
      throw buildRollbackError("Failed to remove channel account", error, [
        ...rollbackErrors,
      ]);
    }
    throw error;
  }
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
