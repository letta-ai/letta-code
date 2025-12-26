/**
 * SubagentGroupStatic - Frozen snapshot of completed subagents
 *
 * Used in Ink's <Static> area for historical/committed items that have
 * scrolled up and should no longer re-render. Pure props-based component
 * with NO hooks (no store subscriptions, no keyboard handlers).
 *
 * This separation from SubagentGroupDisplay is necessary because:
 * - Static area components shouldn't have active subscriptions (memory leaks)
 * - Keyboard handlers would stack up across frozen components
 * - We only need a simple snapshot, not live updates
 *
 * Shows: "Ran N subagents" with final stats (tool count, tokens).
 */

import { Box, Text } from "ink";
import { memo } from "react";
import { formatStats, getTreeChars } from "../helpers/subagentDisplay.js";
import { useTerminalWidth } from "../hooks/useTerminalWidth.js";
import { colors } from "./colors.js";

// ============================================================================
// Types
// ============================================================================

export interface StaticSubagent {
  id: string;
  type: string;
  description: string;
  status: "completed" | "error";
  toolCount: number;
  totalTokens: number;
  agentURL: string | null;
  error?: string;
  model?: string;
}

interface SubagentGroupStaticProps {
  agents: StaticSubagent[];
}

// ============================================================================
// Subcomponents
// ============================================================================

interface AgentRowProps {
  agent: StaticSubagent;
  isLast: boolean;
}

const AgentRow = memo(({ agent, isLast }: AgentRowProps) => {
  const { treeChar, continueChar } = getTreeChars(isLast);
  const columns = useTerminalWidth();
  const gutterWidth = 6; // tree char (1) + " ⎿  " (5)
  const contentWidth = Math.max(0, columns - gutterWidth);

  const dotColor =
    agent.status === "completed"
      ? colors.subagent.completed
      : colors.subagent.error;

  const stats = formatStats(agent.toolCount, agent.totalTokens);

  return (
    <Box flexDirection="column">
      {/* Main row: tree char + description + type + model + stats */}
      <Box flexDirection="row">
        <Text color={colors.subagent.treeChar}>{treeChar} </Text>
        <Text color={dotColor}>●</Text>
        <Text> {agent.description}</Text>
        <Text dimColor> · {agent.type.toLowerCase()}</Text>
        {agent.model && <Text dimColor> · {agent.model}</Text>}
        <Text dimColor> · {stats}</Text>
      </Box>

      {/* Subagent URL */}
      {agent.agentURL && (
        <Box flexDirection="row">
          <Box width={gutterWidth} flexShrink={0}>
            <Text>
              <Text color={colors.subagent.treeChar}>{continueChar}</Text>
              <Text dimColor>{" ⎿  "}</Text>
            </Text>
          </Box>
          <Box flexGrow={1} width={contentWidth}>
            <Text wrap="wrap" dimColor>
              Subagent: {agent.agentURL}
            </Text>
          </Box>
        </Box>
      )}

      {/* Status line */}
      <Box flexDirection="row">
        {agent.status === "completed" ? (
          <>
            <Text color={colors.subagent.treeChar}>{continueChar}</Text>
            <Text dimColor>{" ⎿  Done"}</Text>
          </>
        ) : (
          <>
            <Box width={gutterWidth} flexShrink={0}>
              <Text>
                <Text color={colors.subagent.treeChar}>{continueChar}</Text>
                <Text dimColor>{" ⎿  "}</Text>
              </Text>
            </Box>
            <Box flexGrow={1} width={contentWidth}>
              <Text wrap="wrap" color={colors.subagent.error}>
                {agent.error}
              </Text>
            </Box>
          </>
        )}
      </Box>
    </Box>
  );
});

AgentRow.displayName = "AgentRow";

// ============================================================================
// Main Component
// ============================================================================

export const SubagentGroupStatic = memo(
  ({ agents }: SubagentGroupStaticProps) => {
    if (agents.length === 0) {
      return null;
    }

    const statusText = `Ran ${agents.length} subagent${agents.length !== 1 ? "s" : ""}`;
    const hasErrors = agents.some((a) => a.status === "error");

    // Use error color for dot if any subagent errored
    const dotColor = hasErrors
      ? colors.subagent.error
      : colors.subagent.completed;

    return (
      <Box flexDirection="column">
        {/* Header */}
        <Box flexDirection="row">
          <Text color={dotColor}>⏺</Text>
          <Text color={colors.subagent.header}> {statusText}</Text>
        </Box>

        {/* Agent rows */}
        {agents.map((agent, index) => (
          <AgentRow
            key={agent.id}
            agent={agent}
            isLast={index === agents.length - 1}
          />
        ))}
      </Box>
    );
  },
);

SubagentGroupStatic.displayName = "SubagentGroupStatic";
