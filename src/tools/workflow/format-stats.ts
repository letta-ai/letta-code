export function formatCompactTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n < 1000) return String(Math.round(n));
  const scaled = n < 1_000_000 ? n / 1000 : n / 1_000_000;
  const suffix = n < 1_000_000 ? "k" : "M";
  const rounded = Math.round(scaled * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}${suffix}`;
}

export function formatWorkflowDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export interface WorkflowStatsInput {
  durationMs: number;
  agentsDone: number;
  agentsTotal: number;
  totalTokens: number;
  totalCostUsd?: number | null;
}

export function formatUsd(value: number): string {
  return `$${value.toFixed(value < 1 ? 4 : 2)}`;
}

export function formatWorkflowProgress(stats: WorkflowStatsInput): string {
  const parts = [
    `${stats.agentsDone}/${stats.agentsTotal} agents done`,
    formatWorkflowDuration(stats.durationMs),
  ];
  if (stats.totalTokens > 0) {
    parts.push(`${formatCompactTokens(stats.totalTokens)} tokens`);
  }
  return parts.join(" · ");
}

export function formatWorkflowSummary(stats: WorkflowStatsInput): string {
  const agents = `${stats.agentsTotal} agent${stats.agentsTotal === 1 ? "" : "s"}`;
  const parts = [formatWorkflowDuration(stats.durationMs), agents];
  if (stats.totalTokens > 0) {
    parts.push(`${formatCompactTokens(stats.totalTokens)} tokens`);
  }
  if (typeof stats.totalCostUsd === "number") {
    parts.push(formatUsd(stats.totalCostUsd));
  }
  return parts.join(" · ");
}
