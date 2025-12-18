import type { SessionStatsSnapshot } from "../../agent/stats";

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
    `Session usage:         ${stats.usage.stepCount} steps, ${formatNumber(stats.usage.promptTokens)} input, ${formatNumber(stats.usage.completionTokens)} output`,
    "",
  ];

  if (balance) {
    outputLines.push(
      `Available credits:     $${balance.total_balance.toFixed(2)}       Plan: [${balance.billing_tier}]`,
      `  Monthly credits:     $${balance.monthly_credit_balance.toFixed(2)}`,
      `  Purchased credits:   $${balance.purchased_credit_balance.toFixed(2)}`,
    );
  }

  return outputLines.join("\n");
}
