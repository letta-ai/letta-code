import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  ChannelAccountMutationConflictError,
  ChannelCredentialHydrationError,
  ChannelCredentialPersistenceError,
} from "./account-errors";
import { accountsMatchForMutation as accountsMatch } from "./account-mutation-compare";
import {
  clearChannelAccountMutationState,
  flushPendingChannelSecretWrites,
  queueSecretWrite,
  withAccountMutationLock,
} from "./account-mutation-locks";
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

export {
  ChannelAccountMutationConflictError,
  ChannelCredentialHydrationError,
  ChannelCredentialPersistenceError,
} from "./account-errors";
export { flushPendingChannelSecretWrites } from "./account-mutation-locks";

interface ChannelAccountStore {
  accounts: ChannelAccount[];
}

export const LEGACY_CHANNEL_ACCOUNT_ID = "__legacy_migrated__";

const stores = new Map<string, ChannelAccountStore>();

type PrepareAccountForStorageOptions = {
  queueSecretWrites?: boolean;
  markNewSecretRefs?: boolean;
};

type ExpectedCurrentAccountOptions = {
  expectedCurrent?: ChannelAccount | null;
};

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

function markPresentSecretRefs(account: ChannelAccount): void {
  for (const fieldPath of getAccountSecretFieldPaths(account)) {
    const value = getSecretValueFromAccount(account, fieldPath);
    if (isNonEmptyString(value)) {
      markSecretRef(account, fieldPath);
    }
  }
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

  const persistedRefs = getSecretRefs(cloned);
  delete cloned[CHANNEL_SECRET_REFS_KEY];
  for (const fieldPath of secretFieldPaths) {
    const value = getSecretValueFromAccount(cloned, fieldPath);
    if (isNonEmptyString(value)) {
      if (
        persistedRefs[fieldPath] !== true &&
        options.markNewSecretRefs === false
      ) {
        continue;
      }
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
  options: Pick<PrepareAccountForStorageOptions, "markNewSecretRefs"> = {},
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
  saveChannelAccounts(channelId, {
    queueSecretWrites: false,
    markNewSecretRefs: options.markNewSecretRefs,
  });
}

function setTargetAccountInMemory(
  channelId: string,
  accountId: string,
  account: ChannelAccount,
): void {
  const store = getStore(channelId);
  const cloned = cloneAccount(account);
  const index = store.accounts.findIndex(
    (entry) => entry.accountId === accountId,
  );
  if (index >= 0) {
    store.accounts[index] = cloned;
  } else {
    store.accounts.push(cloned);
  }
}

function hasExpectedCurrent(
  options: ExpectedCurrentAccountOptions,
): options is Required<ExpectedCurrentAccountOptions> {
  return Object.hasOwn(options, "expectedCurrent");
}

function assertExpectedCurrentAccount(
  channelId: string,
  accountId: string,
  expectedCurrent: ChannelAccount | null,
): void {
  if (
    !accountsMatch(snapshotStoreAccount(channelId, accountId), expectedCurrent)
  ) {
    throw new ChannelAccountMutationConflictError(channelId, accountId);
  }
}

async function restoreSecretsAndThrowConflict(
  channelId: string,
  accountId: string,
  secretSnapshots: ChannelSecretSnapshot[],
): Promise<never> {
  try {
    await restoreChannelSecretSnapshots(channelId, accountId, secretSnapshots);
  } catch (rollbackError) {
    throw buildRollbackError(
      "Channel account changed while saving credentials",
      new ChannelAccountMutationConflictError(channelId, accountId),
      [rollbackError],
    );
  }
  throw new ChannelAccountMutationConflictError(channelId, accountId);
}

type HydratedSecretPlan = {
  fieldPath: string;
  value: string;
  writeSecret: boolean;
};

type HydratedAccountSecrets = {
  account: ChannelAccount;
  shouldPersistAccount: boolean;
  secretSnapshots: ChannelSecretSnapshot[];
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
): Promise<HydratedAccountSecrets> {
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
  const previousValues: ChannelSecretSnapshot[] = [];
  if (writePlans.length > 0) {
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

  return {
    account,
    shouldPersistAccount,
    secretSnapshots: previousValues,
  };
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

  const accountIds = accountId
    ? store.accounts
        .filter((account) => account.accountId === accountId)
        .map((account) => account.accountId)
    : store.accounts.map((account) => account.accountId);

  for (const currentAccountId of accountIds) {
    await withAccountMutationLock(channelId, currentAccountId, async () => {
      await flushPendingChannelSecretWrites({
        channelId,
        accountId: currentAccountId,
      });
      const current = snapshotStoreAccount(channelId, currentAccountId);
      if (!current) {
        return;
      }
      const hydrated = await hydrateAccountSecrets(cloneAccount(current));
      const afterHydration = snapshotStoreAccount(channelId, currentAccountId);
      if (!accountsMatch(afterHydration, current)) {
        await restoreSecretsAndThrowConflict(
          channelId,
          currentAccountId,
          hydrated.secretSnapshots,
        );
      }
      if (hydrated.shouldPersistAccount) {
        writeTargetAccountWithoutSecretWrites(
          channelId,
          currentAccountId,
          hydrated.account,
          { markNewSecretRefs: false },
        );
      } else {
        setTargetAccountInMemory(channelId, currentAccountId, hydrated.account);
      }
    });
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
  options: ExpectedCurrentAccountOptions = {},
): Promise<ChannelAccount> {
  const mode = await getActiveChannelCredentialsStoreMode();
  const accountId = account.accountId;
  if (mode !== "keyring") {
    if (hasExpectedCurrent(options)) {
      assertExpectedCurrentAccount(
        channelId,
        accountId,
        options.expectedCurrent,
      );
    }
    return upsertChannelAccount(channelId, account);
  }

  return withAccountMutationLock(channelId, accountId, async () => {
    await flushPendingChannelSecretWrites({ channelId, accountId });

    const previousAccount = snapshotStoreAccount(channelId, accountId);
    if (hasExpectedCurrent(options)) {
      assertExpectedCurrentAccount(
        channelId,
        accountId,
        options.expectedCurrent,
      );
    }
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

    if (
      !accountsMatch(
        snapshotStoreAccount(channelId, accountId),
        previousAccount,
      )
    ) {
      await restoreSecretsAndThrowConflict(
        channelId,
        accountId,
        secretSnapshots,
      );
    }
    markPresentSecretRefs(nextAccount);

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

export function upsertChannelAccountMetadataIfCurrent(
  channelId: string,
  account: ChannelAccount,
  expectedCurrent: ChannelAccount | null,
): ChannelAccount {
  const previousAccount = snapshotStoreAccount(channelId, account.accountId);
  assertExpectedCurrentAccount(channelId, account.accountId, expectedCurrent);
  try {
    writeTargetAccountWithoutSecretWrites(
      channelId,
      account.accountId,
      account,
      {
        markNewSecretRefs: false,
      },
    );
  } catch (error) {
    try {
      writeTargetAccountWithoutSecretWrites(
        channelId,
        account.accountId,
        previousAccount,
        { markNewSecretRefs: false },
      );
    } catch (rollbackError) {
      throw buildRollbackError(
        "Failed to save channel account metadata",
        error,
        [rollbackError],
      );
    }
    throw error;
  }
  return cloneAccount(account);
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
  options: ExpectedCurrentAccountOptions = {},
): Promise<boolean> {
  const mode = await getActiveChannelCredentialsStoreMode();
  if (mode !== "keyring") {
    if (hasExpectedCurrent(options)) {
      assertExpectedCurrentAccount(
        channelId,
        accountId,
        options.expectedCurrent,
      );
    }
    return removeChannelAccount(channelId, accountId);
  }

  return withAccountMutationLock(channelId, accountId, async () => {
    const account = getChannelAccount(channelId, accountId);
    if (!account) {
      return false;
    }
    if (hasExpectedCurrent(options)) {
      assertExpectedCurrentAccount(
        channelId,
        accountId,
        options.expectedCurrent,
      );
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

    if (
      !accountsMatch(
        snapshotStoreAccount(channelId, accountId),
        previousAccount,
      )
    ) {
      await restoreSecretsAndThrowConflict(
        channelId,
        accountId,
        secretSnapshots,
      );
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
  clearChannelAccountMutationState();
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
