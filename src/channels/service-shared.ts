import { refreshDynamicChannelToolsInLoadedRegistry } from "@/tools/manager";
import {
  getChannelAccount,
  getChannelAccountWithSecrets,
  listChannelAccounts,
} from "./accounts";
import { isSupportedChannelId } from "./plugin-registry";
import type { ChannelAccount, SupportedChannelId } from "./types";

export async function refreshLoadedMessageChannelTool(): Promise<void> {
  await refreshDynamicChannelToolsInLoadedRegistry();
}

export function assertSupportedChannelId(
  channelId: string,
): asserts channelId is SupportedChannelId {
  if (!isSupportedChannelId(channelId)) {
    throw new Error(`Unsupported channel: ${channelId}`);
  }
}

export function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function normalizeDisplayName(
  value: string | undefined,
): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function getSelectedChannelAccount(
  channelId: string,
  accountId?: string,
): ChannelAccount | null {
  const normalizedAccountId = accountId?.trim();
  if (normalizedAccountId) {
    return getChannelAccount(channelId, normalizedAccountId);
  }

  const accounts = listChannelAccounts(channelId);
  if (accounts.length === 0) {
    return null;
  }
  if (accounts.length === 1) {
    return accounts[0] ?? null;
  }

  throw new Error(
    `Channel "${channelId}" has multiple accounts. Specify account_id.`,
  );
}

export async function getSelectedChannelAccountWithSecrets(
  channelId: string,
  accountId?: string,
): Promise<ChannelAccount | null> {
  const normalizedAccountId = accountId?.trim();
  if (normalizedAccountId) {
    return getChannelAccountWithSecrets(channelId, normalizedAccountId);
  }

  const accounts = listChannelAccounts(channelId);
  if (accounts.length === 0) {
    return null;
  }
  if (accounts.length === 1) {
    const [account] = accounts;
    return account
      ? getChannelAccountWithSecrets(channelId, account.accountId)
      : null;
  }

  throw new Error(
    `Channel "${channelId}" has multiple accounts. Specify account_id.`,
  );
}
