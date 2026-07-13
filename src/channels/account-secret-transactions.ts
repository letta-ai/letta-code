import {
  deleteChannelSecret,
  getChannelSecret,
  setChannelSecret,
} from "./credential-store";
import {
  configSecretFieldPathToKey,
  getAccountSecretFieldPaths,
  isNonEmptyString,
  isSecretPlaceholderValue,
} from "./credential-utils";
import type { ChannelAccount, CustomChannelAccount } from "./types";

export type ChannelSecretSnapshot = {
  fieldPath: string;
  value: string | null;
};

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

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : fallback;
}

export function buildRollbackError(
  operation: string,
  error: unknown,
  rollbackErrors: unknown[],
): Error {
  return new Error(
    `${operation}: ${getErrorMessage(
      error,
      "operation failed",
    )}. Rollback failed: ${rollbackErrors
      .map((rollbackError) => getErrorMessage(rollbackError, "rollback failed"))
      .join("; ")}`,
    { cause: error },
  );
}

export function getMutationSecretFieldPaths(
  ...accounts: Array<ChannelAccount | null | undefined>
): string[] {
  return [
    ...new Set(
      accounts.flatMap((account) =>
        account ? getAccountSecretFieldPaths(account) : [],
      ),
    ),
  ];
}

export async function captureChannelSecretSnapshots(
  channelId: string,
  accountId: string,
  account: ChannelAccount | null | undefined,
  fieldPaths: string[],
): Promise<ChannelSecretSnapshot[]> {
  const snapshots: ChannelSecretSnapshot[] = [];
  for (const fieldPath of fieldPaths) {
    const accountValue = account
      ? getSecretValueFromAccount(account, fieldPath)
      : undefined;
    if (
      isNonEmptyString(accountValue) &&
      !isSecretPlaceholderValue(accountValue)
    ) {
      snapshots.push({ fieldPath, value: accountValue });
      continue;
    }
    snapshots.push({
      fieldPath,
      value: await getChannelSecret(channelId, accountId, fieldPath),
    });
  }
  return snapshots;
}

export async function restoreChannelSecretSnapshots(
  channelId: string,
  accountId: string,
  snapshots: ChannelSecretSnapshot[],
): Promise<void> {
  const errors: unknown[] = [];
  for (const snapshot of snapshots) {
    try {
      if (snapshot.value === null) {
        await deleteChannelSecret(channelId, accountId, snapshot.fieldPath);
      } else {
        await setChannelSecret(
          channelId,
          accountId,
          snapshot.fieldPath,
          snapshot.value,
        );
      }
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new Error(
      `Failed to restore channel credential store: ${errors
        .map((error) => getErrorMessage(error, "restore failed"))
        .join("; ")}`,
    );
  }
}

export async function writeForegroundAccountSecrets(
  account: ChannelAccount,
): Promise<void> {
  for (const fieldPath of getAccountSecretFieldPaths(account)) {
    const value = getSecretValueFromAccount(account, fieldPath);
    if (isNonEmptyString(value) && !isSecretPlaceholderValue(value)) {
      await setChannelSecret(
        account.channel,
        account.accountId,
        fieldPath,
        value,
      );
    }
  }
}

export async function deleteForegroundAccountSecrets(
  channelId: string,
  accountId: string,
  snapshots: ChannelSecretSnapshot[],
): Promise<void> {
  for (const snapshot of snapshots) {
    const deleted = await deleteChannelSecret(
      channelId,
      accountId,
      snapshot.fieldPath,
    );
    if (!deleted && snapshot.value !== null) {
      throw new Error(
        `Failed to delete ${channelId}/${accountId}/${snapshot.fieldPath} from the channel credential store.`,
      );
    }
  }
}
