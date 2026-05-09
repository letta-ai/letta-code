import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { SessionStatsSnapshot, UsageStats } from "../../agent/stats";
import { buildAppUrl } from "../helpers/appUrls";
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

interface ModelPricing {
  input: number;
  cached_input?: number;
  cache_write?: number;
  output: number;
  reasoning?: number;
  /** Pricing unit: "per_M_tokens" (per million, default) or "per_1k_tokens" */
  unit?: "per_M_tokens" | "per_1k_tokens";
}

interface PricingConfig {
  [modelHandle: string]: ModelPricing;
}

interface FormatUsageStatsOptions {
  stats: SessionStatsSnapshot;
  balance?: BalanceInfo;
  modelHandle?: string | null;
}

/**
 * Load pricing config from ~/.letta/pricing.json.
 * Returns pricing for the given model handle, or null if not configured.
 */
export function loadPricingForModel(
  modelHandle: string | null | undefined,
): ModelPricing | null {
  if (!modelHandle) return null;
  try {
    const configPath = join(homedir(), ".letta", "pricing.json");
    if (!existsSync(configPath)) return null;
    const raw = readFileSync(configPath, "utf-8");
    const config: PricingConfig = JSON.parse(raw);
    return config[modelHandle] ?? null;
  } catch {
    return null;
  }
}

/**
 * Calculate session cost from usage stats and model pricing.
 * Prices are in USD per million tokens (default) or per 1k tokens.
 */
export function calculateSessionCost(
  usage: UsageStats,
  pricing: ModelPricing,
): { total: number; breakdown: Record<string, number> } {
  const unit = pricing.unit ?? "per_M_tokens";
  const divisor = unit === "per_1k_tokens" ? 1_000 : 1_000_000;

  // Uncached input = total input - cached input - cache write
  const uncachedInput = Math.max(
    0,
    usage.promptTokens -
      usage.cachedInputTokens -
      usage.cacheWriteTokens,
  );
  const cachedInput = usage.cachedInputTokens;
  const cacheWrite = usage.cacheWriteTokens;
  const output = usage.completionTokens;
  const reasoning = usage.reasoningTokens;

  const inputCost = (uncachedInput / divisor) * pricing.input;
  const cachedInputCost =
    pricing.cached_input != null
      ? (cachedInput / divisor) * pricing.cached_input
      : 0;
  const cacheWriteCost =
    pricing.cache_write != null
      ? (cacheWrite / divisor) * pricing.cache_write
      : 0;
  const outputCost = (output / divisor) * pricing.output;
  const reasoningCost =
    pricing.reasoning != null
      ? (reasoning / divisor) * pricing.reasoning
      : outputCost > 0
        ? 0 // reasoning priced via output already
        : 0;

  const total =
    inputCost + cachedInputCost + cacheWriteCost + outputCost + reasoningCost;

  return {
    total,
    breakdown: {
      input: inputCost,
      cached_input: cachedInputCost,
      cache_write: cacheWriteCost,
      output: outputCost,
      reasoning: reasoningCost,
    },
  };
}

function formatCost(cost: number): string {
  if (cost < 0.001) return "$0.000";
  return `$${cost.toFixed(3)}`;
}

/**
 * Format usage statistics as markdown text for display in CommandMessage
 */
export function formatUsageStats({
  stats,
  balance,
  modelHandle,
}: FormatUsageStatsOptions): string {
  const outputLines = [
    `Total duration (API):  ${formatDuration(stats.totalApiMs)}`,
    `Total duration (wall): ${formatDuration(stats.totalWallMs)}`,
    `Session usage:         ${stats.usage.stepCount} steps, ${formatCompact(stats.usage.promptTokens)} input, ${formatCompact(stats.usage.completionTokens)} output`,
    `Token details:         ${formatCompact(stats.usage.totalTokens)} total, ${formatCompact(stats.usage.cachedInputTokens)} cached_input, ${formatCompact(stats.usage.cacheWriteTokens)} cache_write, ${formatCompact(stats.usage.reasoningTokens)} reasoning`,
    ...(stats.usage.contextTokens !== undefined
      ? [
          `Latest context:       ${formatCompact(stats.usage.contextTokens)} tokens`,
        ]
      : []),
  ];

  // Session cost from local pricing config (self-hosted / BYOK)
  const pricing = loadPricingForModel(modelHandle);
  if (pricing) {
    const { total, breakdown } = calculateSessionCost(stats.usage, pricing);
    outputLines.push(
      `Session cost:          ${formatCost(total)} (input: ${formatCost(breakdown.input ?? 0)}, output: ${formatCost(breakdown.output ?? 0)}, cached: ${formatCost(breakdown.cached_input ?? 0)}, cache_write: ${formatCost(breakdown.cache_write ?? 0)}, reasoning: ${formatCost(breakdown.reasoning ?? 0)})`,
    );
  }

  outputLines.push("");

  if (balance) {
    // API returns credits (integers), dollars = credits / 1000
    const totalCredits = Math.round(balance.total_balance);
    const monthlyCredits = Math.round(balance.monthly_credit_balance);
    const purchasedCredits = Math.round(balance.purchased_credit_balance);

    const toDollars = (credits: number) => (credits / 1000).toFixed(2);

    outputLines.push(
      `Plan: [${balance.billing_tier}]`,
      buildAppUrl("/settings/organization/usage"),
      "",
      `Available credits:     ◎${formatNumber(totalCredits)} ($${toDollars(totalCredits)})`,
      `Monthly credits:       ◎${formatNumber(monthlyCredits)} ($${toDollars(monthlyCredits)})`,
      `Purchased credits:     ◎${formatNumber(purchasedCredits)} ($${toDollars(purchasedCredits)})`,
    );
  }

  return outputLines.join("\n");
}
