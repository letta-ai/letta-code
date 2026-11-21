import { getModelShortName, resolveModel } from "@/agent/model";
import { OPENAI_CODEX_PROVIDER_NAME } from "@/providers/openai-codex-provider";
import { formatCompact } from "./format";

export function formatStats(toolCount: number, totalTokens: number): string {
  const toolStr = `${toolCount} tool use${toolCount !== 1 ? "s" : ""}`;

  if (totalTokens > 0) {
    return `${toolStr} · ${formatCompact(totalTokens)} tokens`;
  }

  return toolStr;
}

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
}

/**
 * Format a subagent model identifier using the same logic as the input footer:
 * short label (if known) + provider-based BYOK marker eligibility.
 */
export function getSubagentModelDisplay(
  model: string | undefined,
): SubagentModelDisplay | null {
  if (!model) return null;

  const normalized = resolveModel(model) ?? model;
  const slashIndex = normalized.indexOf("/");
  const provider =
    slashIndex >= 0 ? normalized.slice(0, slashIndex) : normalized;
  const isOpenAICodexProvider = provider === OPENAI_CODEX_PROVIDER_NAME;
  const isByokProvider = provider.startsWith("lc-") || isOpenAICodexProvider;
  const label =
    getModelShortName(normalized) ?? normalized.split("/").pop() ?? normalized;

  return {
    label,
    isByokProvider,
    isOpenAICodexProvider,
  };
}
