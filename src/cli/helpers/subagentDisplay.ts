/**
 * Shared utilities for subagent display components
 *
 * Used by both SubagentGroupDisplay (live) and SubagentGroupStatic (frozen).
 */

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
