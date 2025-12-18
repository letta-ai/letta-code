/**
 * Shared utilities for subagent display components
 *
 * Used by both SubagentGroupDisplay (live) and SubagentGroupStatic (frozen).
 */

/**
 * Format tool count and token statistics for display
 *
 * @param toolCount - Number of tool calls
 * @param totalTokens - Total tokens used
 * @param isRunning - If true, shows "—" for tokens (since usage is only available at end)
 */
export function formatStats(
  toolCount: number,
  totalTokens: number,
  isRunning = false,
): string {
  const tokenStr = isRunning
    ? "—"
    : totalTokens >= 1000
      ? `${(totalTokens / 1000).toFixed(1)}k`
      : String(totalTokens);
  return `${toolCount} tool use${toolCount !== 1 ? "s" : ""} · ${tokenStr} tokens`;
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
    continueChar: isLast ? "   " : "│  ",
  };
}
