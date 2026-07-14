import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  cloneAccount,
  normalizeLoadedAccount,
  resetAccountNormalizationWarnings,
  SNAKE_TO_CAMEL,
} from "./account-normalization";
import {
  buildRollbackError,
  type ChannelSecretSnapshot,
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
import type { ChannelAccount, CustomChannelAccount } from "./types";

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
const accountMutationLocks = new Map<string, Promise<void>>();

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

async function withAccountMutationLock<T>(
  channelId: string,
  accountId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = `${channelId}\0${accountId}`;
  const previous = accountMutationLocks.get(key) ?? Promise.resolve();
  let releaseCurrent: () => void = () => {};
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const tail = previous.catch(() => {}).then(() => current);
  accountMutationLocks.set(key, tail);

  await previous.catch(() => {});
  try {
    return await fn();
  } finally {
    releaseCurrent();
    if (accountMutationLocks.get(key) === tail) {
      accountMutationLocks.delete(key);
    }
  }
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

function snapshotStoreAccount(
  channelId: string,
  accountId: string,
): ChannelAccount | null {
  const account = getStore(channelId).accounts.find(
    (entry) => entry.accountId === accountId,
  );
  return account ? cloneAccount(account) : null;
}

function writeTargetAccountWithoutSecretWrites(
  channelId: string,
  accountId: string,
  account: ChannelAccount | null,
): void {
  const store = getStore(channelId);
  const nextAccounts = store.accounts.map((entry) => cloneAccount(entry));
  const index = nextAccounts.findIndex(
    (entry) => entry.accountId === accountId,
  );
  if (account) {
    const cloned = cloneAccount(account);
    if (index >= 0) {
      nextAccounts[index] = cloned;
    } else {
      nextAccounts.push(cloned);
    }
  } else if (index >= 0) {
    nextAccounts.splice(index, 1);
  }
  store.accounts = nextAccounts;
  saveChannelAccounts(channelId, { queueSecretWrites: false });
}

function accountsMatch(
  left: ChannelAccount | null,
  right: ChannelAccount | null,
): boolean {
  if (!left || !right) {
    return left === right;
  }
  return JSON.stringify(left) === JSON.stringify(right);
}

type HydratedSecretPlan = {
  fieldPath: string;
  value: string;
  writeSecret: boolean;
};

async function readStoredSecretForHydration(
  account: ChannelAccount,
  fieldPath: string,
): Promise<string | null> {
  try {
    return await getChannelSecret(
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
}

async function hydrateAccountSecrets(
  account: ChannelAccount,
): Promise<boolean> {
  const persistedRefs = getSecretRefs(account);
  const plans: HydratedSecretPlan[] = [];
  let shouldPersistAccount = false;

  for (const fieldPath of getAccountSecretFieldPaths(account)) {
    const currentValue = getSecretValueFromAccount(account, fieldPath);
    const hasPersistedRef = persistedRefs[fieldPath] === true;

    if (hasPersistedRef) {
      const storedValue = await readStoredSecretForHydration(
        account,
        fieldPath,
      );
      if (isNonEmptyString(storedValue)) {
        plans.push({ fieldPath, value: storedValue, writeSecret: false });
        if (
          isNonEmptyString(currentValue) &&
          !isSecretPlaceholder(currentValue)
        ) {
          shouldPersistAccount = true;
        }
        continue;
      }

      if (
        isNonEmptyString(currentValue) &&
        !isSecretPlaceholder(currentValue)
      ) {
        plans.push({ fieldPath, value: currentValue, writeSecret: true });
        shouldPersistAccount = true;
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

    if (isSecretPlaceholder(currentValue)) {
      throw new ChannelCredentialHydrationError(
        account.channel,
        account.accountId,
        fieldPath,
      );
    }

    if (isNonEmptyString(currentValue)) {
      plans.push({ fieldPath, value: currentValue, writeSecret: true });
      shouldPersistAccount = true;
    }
  }

  const writePlans = plans.filter((plan) => plan.writeSecret);
  if (writePlans.length > 0) {
    const previousValues: ChannelSecretSnapshot[] = [];
    for (const plan of writePlans) {
      previousValues.push({
        fieldPath: plan.fieldPath,
        value: await readStoredSecretForHydration(account, plan.fieldPath),
      });
    }

    try {
      for (const plan of writePlans) {
        await setChannelSecret(
          account.channel,
          account.accountId,
          plan.fieldPath,
          plan.value,
        );
      }
    } catch (error) {
      try {
        await restoreChannelSecretSnapshots(
          account.channel,
          account.accountId,
          previousValues,
        );
      } catch (rollbackError) {
        throw buildRollbackError(
          "Failed to hydrate channel credentials",
          error,
          [rollbackError],
        );
      }
      throw error;
    }
  }

  for (const plan of plans) {
    markSecretRef(account, plan.fieldPath);
    setSecretValueOnAccount(account, plan.fieldPath, plan.value);
  }

  return shouldPersistAccount;
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
    saveChannelAccounts(channelId, { queueSecretWrites: false });
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
  return withAccountMutationLock(channelId, accountId, async () => {
    await flushPendingChannelSecretWrites({ channelId, accountId });

    const previousAccount = snapshotStoreAccount(channelId, accountId);
    const nextAccount = cloneAccount(account);
    const fieldPaths = getMutationSecretFieldPaths(
      previousAccount,
      nextAccount,
    );
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

    try {
      writeTargetAccountWithoutSecretWrites(channelId, accountId, nextAccount);
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      try {
        writeTargetAccountWithoutSecretWrites(
          channelId,
          accountId,
          previousAccount,
        );
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
  });
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
  if (mode !== "keyring") {
    return removeChannelAccount(channelId, accountId);
  }

  return withAccountMutationLock(channelId, accountId, async () => {
    const account = getChannelAccount(channelId, accountId);
    if (!account) {
      return false;
    }

    await flushPendingChannelSecretWrites({ channelId, accountId });
    const previousAccount = cloneAccount(account);
    const secretSnapshots = await captureChannelSecretSnapshots(
      channelId,
      accountId,
      account,
      getAccountSecretFieldPaths(account),
    );

    try {
      await deleteForegroundAccountSecrets(
        channelId,
        accountId,
        secretSnapshots,
      );
    } catch (error) {
      try {
        await restoreChannelSecretSnapshots(
          channelId,
          accountId,
          secretSnapshots,
        );
      } catch (rollbackError) {
        throw buildRollbackError(
          "Failed to delete channel credentials",
          error,
          [rollbackError],
        );
      }
      throw error;
    }

    try {
      writeTargetAccountWithoutSecretWrites(channelId, accountId, null);
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      try {
        writeTargetAccountWithoutSecretWrites(
          channelId,
          accountId,
          previousAccount,
        );
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
  });
}

export async function restoreChannelAccountWithSecretsIfCurrent(
  channelId: string,
  accountId: string,
  expectedCurrent: ChannelAccount | null,
  rollbackAccount: ChannelAccount | null,
  secretSnapshots: ChannelSecretSnapshot[],
): Promise<boolean> {
  const mode = await getActiveChannelCredentialsStoreMode();
  return withAccountMutationLock(channelId, accountId, async () => {
    await flushPendingChannelSecretWrites({ channelId, accountId });
    const current = getChannelAccount(channelId, accountId);
    if (!accountsMatch(current, expectedCurrent)) {
      return false;
    }

    if (mode === "keyring") {
      await restoreChannelSecretSnapshots(
        channelId,
        accountId,
        secretSnapshots,
      );
    }
    writeTargetAccountWithoutSecretWrites(
      channelId,
      accountId,
      rollbackAccount,
    );
    return true;
  });
}

export function clearChannelAccountStores(): void {
  stores.clear();
  accountMutationLocks.clear();
  resetAccountNormalizationWarnings();
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
