import type { SignalChannelAccount } from "@/channels/types";

function normalizeSignalBaseUrlForConflictKey(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString().replace(/\/+$/, "");
  } catch {
    return baseUrl.trim().replace(/\/+$/, "");
  }
}

export function findSignalBaseUrlConflict(
  accounts: SignalChannelAccount[],
): { baseUrl: string; accountIds: string[] } | null {
  const byBaseUrl = new Map<string, string[]>();
  for (const account of accounts) {
    if (!account.enabled) continue;
    const key = normalizeSignalBaseUrlForConflictKey(account.baseUrl);
    const accountIds = byBaseUrl.get(key) ?? [];
    accountIds.push(account.accountId);
    byBaseUrl.set(key, accountIds);
  }
  for (const [baseUrl, accountIds] of byBaseUrl.entries()) {
    if (accountIds.length > 1) return { baseUrl, accountIds };
  }
  return null;
}

export function findSignalBaseUrlConflictForStart(
  accounts: SignalChannelAccount[],
  accountToStart: SignalChannelAccount,
): { baseUrl: string; accountIds: string[] } | null {
  const targetBaseUrl = normalizeSignalBaseUrlForConflictKey(
    accountToStart.baseUrl,
  );
  const accountIds = accounts
    .filter(
      (account) =>
        account.accountId !== accountToStart.accountId &&
        account.enabled &&
        normalizeSignalBaseUrlForConflictKey(account.baseUrl) === targetBaseUrl,
    )
    .map((account) => account.accountId);
  if (accountIds.length === 0) return null;
  return {
    baseUrl: targetBaseUrl,
    accountIds: [accountToStart.accountId, ...accountIds],
  };
}

export function buildSignalBaseUrlConflictError(conflict: {
  baseUrl: string;
  accountIds: string[];
}): string {
  return `Signal accounts ${conflict.accountIds.join(", ")} share base_url ${conflict.baseUrl}. Native signal-cli event streams cannot safely run multiple enabled accounts on the same daemon; disable all but one account or run separate signal-cli daemons on separate ports/config dirs.`;
}
