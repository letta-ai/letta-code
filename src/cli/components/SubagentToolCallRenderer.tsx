import { Box, Text } from "ink";
import { memo } from "react";
import { BlinkDot } from "./BlinkDot.js";
import { colors } from "./colors.js";

/**
 * Subagent data attached to a Task tool call
 */
export interface SubagentData {
  id: string;
  type: string;
  description: string;
  status: "pending" | "running" | "completed" | "error";
  toolCount: number;
  totalTokens: number;
  agentURL: string | null;
  error?: string;
}

/**
 * Renders a Task tool call with subagent information.
 * Shows:
 * - Header: "Running 1 {type} agent..." or "Ran 1 {type} agent"
 * - Agent row with status dot, description, stats
 * - Subagent URL (if available)
 * - Status line (Done/Error/Running)
 */
export const SubagentToolCallRenderer = memo(
  ({ subagent }: { subagent: SubagentData }) => {
    // Format stats - show "—" for tokens while running since we only get usage at the end
    const isRunning =
      subagent.status === "pending" || subagent.status === "running";
    const tokenStr = isRunning
      ? "—"
      : subagent.totalTokens >= 1000
        ? `${(subagent.totalTokens / 1000).toFixed(1)}k`
        : String(subagent.totalTokens);
    const stats = `${subagent.toolCount} tool use${subagent.toolCount !== 1 ? "s" : ""} · ${tokenStr} tokens`;

    // Get status indicator
    const getSubagentDot = () => {
      switch (subagent.status) {
        case "pending":
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

    // Determine header text
    const headerText =
      subagent.status === "completed" || subagent.status === "error"
        ? `Ran 1 ${subagent.type} agent`
        : `Running 1 ${subagent.type} agent…`;

    // Get status line
    const getStatusLine = () => {
      if (subagent.status === "completed") {
        return <Text dimColor>  ⎿  Done</Text>;
      }
      if (subagent.status === "error") {
        return (
          <Text color={colors.subagent.error}>
            {"  "}⎿ Error: {subagent.error}
          </Text>
        );
      }
      return <Text dimColor>  ⎿  Running...</Text>;
    };

    return (
      <Box flexDirection="column">
        {/* Header: ⏺ Ran 1 Explore agent */}
        <Box flexDirection="row">
          {subagent.status === "completed" || subagent.status === "error" ? (
            <Text color={colors.subagent.completed}>⏺</Text>
          ) : (
            <BlinkDot color={colors.subagent.header} />
          )}
          <Text color={colors.subagent.header}> {headerText}</Text>
        </Box>

        {/* Agent row: └─ ● description · stats */}
        <Box flexDirection="row">
          <Text color={colors.subagent.treeChar}>└─ </Text>
          {getSubagentDot()}
          <Text> {subagent.description}</Text>
          <Text color={colors.subagent.stats}> · {stats}</Text>
        </Box>

        {/* Subagent URL if available */}
        {subagent.agentURL && (
          <Box flexDirection="row">
            <Text color={colors.subagent.treeChar}>   </Text>
            <Text dimColor>  ⎿  Subagent: {subagent.agentURL}</Text>
          </Box>
        )}

        {/* Status line */}
        <Box flexDirection="row">
          <Text color={colors.subagent.treeChar}>   </Text>
          {getStatusLine()}
        </Box>
      </Box>
    );
  },
);

SubagentToolCallRenderer.displayName = "SubagentToolCallRenderer";
