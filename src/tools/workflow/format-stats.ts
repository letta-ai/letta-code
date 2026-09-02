/**
 * Shared formatting for workflow execution statistics. Lives in the tools
 * layer so both the tool (completion notification summary) and the CLI
 * (status row, /workflows, transcript lines) print identical numbers.
 */

/** 500 → "500", 5200 → "5.2k", 167200 → "167.2k", 2_400_000 → "2.4M". */
export function formatCompactTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n < 1000) return String(Math.round(n));
  const scaled = n < 1_000_000 ? n / 1000 : n / 1_000_000;
  const suffix = n < 1_000_000 ? "k" : "M";
  const rounded = Math.round(scaled * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}${suffix}`;
}

/** 9_400 → "9s", 65_000 → "1m 05s", 3_725_000 → "1h 02m". */
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
}

/**
 * Progress fragment for a live row: "2/3 agents done · 9s · ↓ 133.6k tokens".
 * Tokens are omitted while none have been reported.
 */
export function formatWorkflowProgress(stats: WorkflowStatsInput): string {
  const parts = [
    `${stats.agentsDone}/${stats.agentsTotal} agents done`,
    formatWorkflowDuration(stats.durationMs),
  ];
  if (stats.totalTokens > 0) {
    parts.push(`↓ ${formatCompactTokens(stats.totalTokens)} tokens`);
  }
  return parts.join(" · ");
}

/**
 * Summary fragment for a finished run: "36s · 4 agents · 167.2k tokens".
 */
export function formatWorkflowSummary(stats: WorkflowStatsInput): string {
  const agents = `${stats.agentsTotal} agent${stats.agentsTotal === 1 ? "" : "s"}`;
  const parts = [formatWorkflowDuration(stats.durationMs), agents];
  if (stats.totalTokens > 0) {
    parts.push(`${formatCompactTokens(stats.totalTokens)} tokens`);
  }
  return parts.join(" · ");
}
