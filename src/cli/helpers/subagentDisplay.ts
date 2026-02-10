/**
 * Shared utilities for subagent display components
 *
 * Used by both SubagentGroupDisplay (live) and SubagentGroupStatic (frozen).
 */
import { getModelShortName, resolveModel } from "../../agent/model";
import { OPENAI_CODEX_PROVIDER_NAME } from "../../providers/openai-codex-provider";

/**
 * Format tool count and token statistics for display
 *
 * @param toolCount - Number of tool calls
 * @param totalTokens - Total tokens used (0 or undefined means no data available)
 * @param isRunning - If true, shows "—" for tokens (since usage is only available at end)
 */
export function formatStats(
  toolCount: number,
  totalTokens: number,
  isRunning = false,
): string {
  const toolStr = `${toolCount} tool use${toolCount !== 1 ? "s" : ""}`;

  // Only show token count if we have actual data (not running and totalTokens > 0)
  const hasTokenData = !isRunning && totalTokens > 0;
  if (!hasTokenData) {
    return toolStr;
  }

  const tokenStr =
    totalTokens >= 1000
      ? `${(totalTokens / 1000).toFixed(1)}k`
      : String(totalTokens);
  return `${toolStr} · ${tokenStr} tokens`;
}

/**
 * Get tree-drawing characters for hierarchical display
 *
 * @param isLast - Whether this is the last item in the list
 * @returns Object with treeChar (branch connector) and continueChar (continuation line)
 */
export function getTreeChars(isLast: boolean): {
  treeChar: string;
  continueChar: string;
} {
  return {
    treeChar: isLast ? "└─" : "├─",
    continueChar: isLast ? "  " : "│ ",
  };
}

export interface SubagentModelDisplay {
  label: string;
  isByokProvider: boolean;
  isOpenAICodexProvider: boolean;
  reasoningEffortLabel?: string;
}

/**
 * Format a subagent model identifier using the same logic as the input footer:
 * short label (if known) + provider-based BYOK marker eligibility.
 */
export function getSubagentModelDisplay(
  model: string | undefined,
  reasoningEffort?: string | null,
): SubagentModelDisplay | null {
  if (!model) return null;

  // Normalize model IDs (e.g. "haiku") to handles before formatting.
  const normalized = resolveModel(model) ?? model;
  const slashIndex = normalized.indexOf("/");
  const provider =
    slashIndex >= 0 ? normalized.slice(0, slashIndex) : normalized;
  const isOpenAICodexProvider = provider === OPENAI_CODEX_PROVIDER_NAME;
  const isByokProvider = provider.startsWith("lc-") || isOpenAICodexProvider;
  const label =
    getModelShortName(normalized) ?? normalized.split("/").pop() ?? normalized;

  const effort = typeof reasoningEffort === "string" ? reasoningEffort : null;
  const effortLabel =
    effort === "none" || !effort
      ? undefined
      : effort === "minimal"
        ? "min"
        : effort === "medium"
          ? "med"
          : effort === "med"
            ? "med"
            : effort === "low"
              ? "low"
              : effort === "high"
                ? "high"
                : effort === "xhigh"
                  ? "xhigh"
                  : undefined;

  return {
    label,
    isByokProvider,
    isOpenAICodexProvider,
    reasoningEffortLabel: effortLabel,
  };
}
