import type { SessionStatsSnapshot } from "../../agent/stats";
import { formatCompact } from "../helpers/format";

export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }

  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatNumber(n: number): string {
  return n.toLocaleString();
}

interface BalanceInfo {
  total_balance: number;
  monthly_credit_balance: number;
  purchased_credit_balance: number;
  billing_tier: string;
}

interface FormatUsageStatsOptions {
  stats: SessionStatsSnapshot;
  balance?: BalanceInfo;
}

/**
 * Format usage statistics as markdown text for display in CommandMessage
 */
export function formatUsageStats({
  stats,
  balance,
}: FormatUsageStatsOptions): string {
  const outputLines = [
    `Total duration (API):  ${formatDuration(stats.totalApiMs)}`,
    `Total duration (wall): ${formatDuration(stats.totalWallMs)}`,
    `Session usage:         ${stats.usage.stepCount} steps, ${formatCompact(stats.usage.promptTokens)} input, ${formatCompact(stats.usage.completionTokens)} output`,
    "",
  ];

  if (balance) {
    // API returns credits (integers), dollars = credits / 1000
    const totalCredits = Math.round(balance.total_balance);
    const monthlyCredits = Math.round(balance.monthly_credit_balance);
    const purchasedCredits = Math.round(balance.purchased_credit_balance);

    const toDollars = (credits: number) => (credits / 1000).toFixed(2);

    outputLines.push(
      `Plan: [${balance.billing_tier}]`,
      "https://app.letta.com/settings/organization/usage",
      "",
      `Available credits:     ◎${formatNumber(totalCredits)} ($${toDollars(totalCredits)})`,
      `Monthly credits:       ◎${formatNumber(monthlyCredits)} ($${toDollars(monthlyCredits)})`,
      `Purchased credits:     ◎${formatNumber(purchasedCredits)} ($${toDollars(purchasedCredits)})`,
    );
  }

  return outputLines.join("\n");
}
