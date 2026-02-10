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

import { Box } from "ink";
import { memo } from "react";
import {
  formatStats,
  getSubagentModelDisplay,
  getTreeChars,
} from "../helpers/subagentDisplay.js";
import { useTerminalWidth } from "../hooks/useTerminalWidth.js";
import { colors } from "./colors.js";
import { Text } from "./Text";

// ============================================================================
// Types
// ============================================================================

export interface StaticSubagent {
  id: string;
  type: string;
  description: string;
  status: "completed" | "error" | "running";
  toolCount: number;
  totalTokens: number;
  agentURL: string | null;
  error?: string;
  model?: string;
  reasoningEffort?: string | null;
  isBackground?: boolean;
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
  const gutterWidth = 8; // indent (3) + continueChar (2) + status indent (3)
  const contentWidth = Math.max(0, columns - gutterWidth);

  const isRunning = agent.status === "running";
  const shouldDim = isRunning && !agent.isBackground;
  const stats = formatStats(agent.toolCount, agent.totalTokens, isRunning);
  const modelDisplay = getSubagentModelDisplay(
    agent.model,
    agent.reasoningEffort,
  );

  return (
    <Box flexDirection="column">
      {/* Main row: tree char + description + type + model + stats */}
      <Box flexDirection="row">
        <Text>
          <Text color={colors.subagent.treeChar}>
            {"   "}
            {treeChar}{" "}
          </Text>
          <Text bold={!shouldDim} dimColor={shouldDim}>
            {agent.description}
          </Text>
          <Text dimColor>
            {" · "}
            {agent.type.toLowerCase()}
          </Text>
          {modelDisplay && (
            <>
              <Text dimColor>{` · ${modelDisplay.label}`}</Text>
              {modelDisplay.reasoningEffortLabel && (
                <Text dimColor>{`-${modelDisplay.reasoningEffortLabel}`}</Text>
              )}
              {modelDisplay.isByokProvider && (
                <Text
                  color={
                    modelDisplay.isOpenAICodexProvider ? "#74AA9C" : "yellow"
                  }
                >
                  {" ▲"}
                </Text>
              )}
            </>
          )}
          <Text dimColor>
            {" · "}
            {stats}
          </Text>
        </Text>
      </Box>

      {/* Subagent URL */}
      {agent.agentURL && (
        <Box flexDirection="row">
          <Text color={colors.subagent.treeChar}>
            {"   "}
            {continueChar} ⎿{" "}
          </Text>
          <Text dimColor>{"Subagent: "}</Text>
          <Text dimColor>{agent.agentURL}</Text>
        </Box>
      )}

      {/* Status line */}
      <Box flexDirection="row">
        {agent.status === "completed" && !agent.isBackground ? (
          <>
            <Text color={colors.subagent.treeChar}>
              {"   "}
              {continueChar}
            </Text>
            <Text dimColor>{"   Done"}</Text>
          </>
        ) : agent.status === "error" ? (
          <>
            <Box width={gutterWidth} flexShrink={0}>
              <Text>
                <Text color={colors.subagent.treeChar}>
                  {"   "}
                  {continueChar}
                </Text>
                <Text dimColor>{"   "}</Text>
              </Text>
            </Box>
            <Box flexGrow={1} width={contentWidth}>
              <Text wrap="wrap" color={colors.subagent.error}>
                {agent.error}
              </Text>
            </Box>
          </>
        ) : (
          <>
            <Text color={colors.subagent.treeChar}>
              {"   "}
              {continueChar}
            </Text>
            <Text dimColor>{"   Running in the background"}</Text>
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

    const hasErrors = agents.some((a) => a.status === "error");
    const hasRunning = agents.some((a) => a.status === "running");
    const label = hasRunning ? "Running" : "Ran";
    const suffix = agents.length !== 1 ? "agents" : "agent";

    // Use error color for dot if any subagent errored
    const dotColor = hasErrors
      ? colors.subagent.error
      : hasRunning
        ? colors.tool.pending
        : colors.subagent.completed;

    return (
      <Box flexDirection="column">
        {/* Header */}
        <Box flexDirection="row">
          <Text color={dotColor}>●</Text>
          <Text>
            {" "}
            {label} <Text bold>{agents.length}</Text> {suffix}
          </Text>
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
