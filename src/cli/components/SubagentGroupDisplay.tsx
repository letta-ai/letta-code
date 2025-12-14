/**
 * SubagentGroupDisplay - Renders grouped subagent status in a tree view
 *
 * Displays running/completed subagents with:
 * - Grouped header showing count: "Running 2 Explore agents..."
 * - Tree structure with ├─ └─ │ characters
 * - Real-time stats (tool count, tokens)
 * - Expand/collapse functionality (ctrl+o)
 */

import { Box, Text, useInput } from "ink";
import { memo, useSyncExternalStore } from "react";
import {
  getSnapshot,
  type SubagentState,
  subscribe,
  toggleExpanded,
} from "../helpers/subagentState.js";
import { BlinkDot } from "./BlinkDot.js";
import { colors } from "./colors.js";

// ============================================================================
// Helper Functions
// ============================================================================

function formatStats(
  toolCount: number,
  totalTokens: number,
  isRunning: boolean,
): string {
  // Show "—" for tokens while running since we only get usage at the end
  const tokenStr = isRunning
    ? "—"
    : totalTokens >= 1000
      ? `${(totalTokens / 1000).toFixed(1)}k`
      : String(totalTokens);
  return `${toolCount} tool use${toolCount !== 1 ? "s" : ""} · ${tokenStr} tokens`;
}

function formatToolArgs(argsStr: string): string {
  try {
    const args = JSON.parse(argsStr);
    const entries = Object.entries(args)
      .filter(([_, value]) => value !== undefined && value !== null)
      .slice(0, 2);

    if (entries.length === 0) return "";

    return entries
      .map(([key, value]) => {
        let displayValue = String(value);
        if (displayValue.length > 50) {
          displayValue = `${displayValue.slice(0, 47)}...`;
        }
        return `${key}: "${displayValue}"`;
      })
      .join(", ");
  } catch {
    return "";
  }
}

// ============================================================================
// Subcomponents
// ============================================================================

interface AgentRowProps {
  agent: SubagentState;
  isLast: boolean;
  expanded: boolean;
}

const AgentRow = memo(({ agent, isLast, expanded }: AgentRowProps) => {
  const treeChar = isLast ? "└─" : "├─";
  const continueChar = isLast ? "   " : "│  ";

  const getDotElement = () => {
    switch (agent.status) {
      case "pending":
        return <BlinkDot color={colors.subagent.running} />;
      case "running":
        return <BlinkDot color={colors.subagent.running} />;
      case "completed":
        return <Text color={colors.subagent.completed}>●</Text>;
      case "error":
        return <Text color={colors.subagent.error}>●</Text>;
      default:
        return <Text>●</Text>;
    }
  };

  const isRunning = agent.status === "pending" || agent.status === "running";
  const stats = formatStats(
    agent.toolCalls.length,
    agent.totalTokens,
    isRunning,
  );
  const lastTool = agent.toolCalls[agent.toolCalls.length - 1];

  return (
    <Box flexDirection="column">
      {/* Main row: tree char + description + type + stats */}
      <Box flexDirection="row">
        <Text color={colors.subagent.treeChar}>{treeChar} </Text>
        {getDotElement()}
        <Text> {agent.description}</Text>
        <Text dimColor> · {agent.type.toLowerCase()}</Text>
        <Text color={colors.subagent.stats}> · {stats}</Text>
      </Box>

      {/* Subagent URL */}
      {agent.agentURL && (
        <Box flexDirection="row">
          <Text color={colors.subagent.treeChar}>{continueChar}</Text>
          <Text dimColor> ⎿ Subagent: {agent.agentURL}</Text>
        </Box>
      )}

      {/* Expanded: show all tool calls */}
      {expanded &&
        agent.toolCalls.map((tc) => {
          const formattedArgs = formatToolArgs(tc.args);
          return (
            <Box key={tc.id} flexDirection="row">
              <Text color={colors.subagent.treeChar}>{continueChar}</Text>
              <Text dimColor>
                {"     "}
                {tc.name}({formattedArgs})
              </Text>
            </Box>
          );
        })}

      {/* Status line */}
      <Box flexDirection="row">
        <Text color={colors.subagent.treeChar}>{continueChar}</Text>
        {agent.status === "completed" ? (
          <Text dimColor> ⎿ Done</Text>
        ) : agent.status === "error" ? (
          <Text color={colors.subagent.error}>
            {"  "}⎿ Error: {agent.error}
          </Text>
        ) : lastTool ? (
          <Text dimColor> ⎿ {lastTool.name}</Text>
        ) : (
          <Text dimColor> ⎿ Starting...</Text>
        )}
      </Box>
    </Box>
  );
});

AgentRow.displayName = "AgentRow";

interface GroupHeaderProps {
  count: number;
  allCompleted: boolean;
  expanded: boolean;
}

const GroupHeader = memo(
  ({ count, allCompleted, expanded }: GroupHeaderProps) => {
    const statusText = allCompleted
      ? `Ran ${count} subagent${count !== 1 ? "s" : ""}`
      : `Running ${count} subagent${count !== 1 ? "s" : ""}…`;

    const hint = expanded ? "(ctrl+o to collapse)" : "(ctrl+o to expand)";

    return (
      <Box flexDirection="row">
        {allCompleted ? (
          <Text color={colors.subagent.completed}>⏺</Text>
        ) : (
          <BlinkDot color={colors.subagent.header} />
        )}
        <Text color={colors.subagent.header}> {statusText} </Text>
        <Text color={colors.subagent.hint}>{hint}</Text>
      </Box>
    );
  },
);

GroupHeader.displayName = "GroupHeader";

// ============================================================================
// Main Component
// ============================================================================

export const SubagentGroupDisplay = memo(() => {
  const { agents, expanded } = useSyncExternalStore(subscribe, getSnapshot);

  // Handle ctrl+o for expand/collapse
  useInput((input, key) => {
    if (key.ctrl && input === "o") {
      toggleExpanded();
    }
  });

  // Don't render if no agents
  if (agents.length === 0) {
    return null;
  }

  const allCompleted = agents.every(
    (a) => a.status === "completed" || a.status === "error",
  );

  return (
    <Box flexDirection="column" marginTop={1}>
      <GroupHeader
        count={agents.length}
        allCompleted={allCompleted}
        expanded={expanded}
      />
      {agents.map((agent, index) => (
        <AgentRow
          key={agent.id}
          agent={agent}
          isLast={index === agents.length - 1}
          expanded={expanded}
        />
      ))}
    </Box>
  );
});

SubagentGroupDisplay.displayName = "SubagentGroupDisplay";
