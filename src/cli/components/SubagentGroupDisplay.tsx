/**
 * SubagentGroupDisplay - Live/interactive subagent status display
 *
 * Used in the ACTIVE render area for subagents that may still be running.
 * Subscribes to external store and handles keyboard input - these hooks
 * require the component to stay "alive" and re-rendering.
 *
 * Features:
 * - Real-time updates via useSyncExternalStore
 * - Single blinking dot in header while running
 * - Expand/collapse tool calls (ctrl+o)
 * - Shows "Running N subagents..." while active
 *
 * When agents complete, they get committed to Ink's <Static> area using
 * SubagentGroupStatic instead (a pure props-based snapshot with no hooks).
 */

import { Box, Text, useInput } from "ink";
import { memo, useSyncExternalStore } from "react";
import { formatStats, getTreeChars } from "../helpers/subagentDisplay.js";
import {
  getSnapshot,
  type SubagentState,
  subscribe,
  toggleExpanded,
} from "../helpers/subagentState.js";
import {
  useTerminalRows,
  useTerminalWidth,
} from "../hooks/useTerminalWidth.js";
import { BlinkDot } from "./BlinkDot.js";
import { colors } from "./colors.js";

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
  condensed?: boolean;
}

const AgentRow = memo(
  ({ agent, isLast, expanded, condensed = false }: AgentRowProps) => {
    const { treeChar, continueChar } = getTreeChars(isLast);
    const columns = useTerminalWidth();
    const gutterWidth = 8; // indent (3) + continueChar (2) + status indent (3)
    const contentWidth = Math.max(0, columns - gutterWidth);

    const isRunning = agent.status === "pending" || agent.status === "running";
    const stats = formatStats(
      agent.toolCalls.length,
      agent.totalTokens,
      isRunning,
    );
    const lastTool = agent.toolCalls[agent.toolCalls.length - 1];

    // Condensed mode: simplified view to reduce re-renders when overflowing
    // Shows: "Description · type · model" + "Running..." or "Done"
    // Full details are shown in SubagentGroupStatic when flushed to static area
    if (condensed) {
      const isComplete =
        agent.status === "completed" || agent.status === "error";
      return (
        <Box flexDirection="column">
          {/* Main row: tree char + description + type + model (no stats) */}
          <Box flexDirection="row">
            <Text>
              <Text color={colors.subagent.treeChar}>
                {"   "}
                {treeChar}{" "}
              </Text>
              <Text bold>{agent.description}</Text>
              <Text dimColor>
                {" · "}
                {agent.type.toLowerCase()}
                {agent.model ? ` · ${agent.model}` : ""}
              </Text>
            </Text>
          </Box>
          {/* Simple status line */}
          <Box flexDirection="row">
            <Text color={colors.subagent.treeChar}>
              {"   "}
              {continueChar}
            </Text>
            <Text dimColor>{"   "}</Text>
            {agent.status === "error" ? (
              <Text color={colors.subagent.error}>Error</Text>
            ) : (
              <Text dimColor>{isComplete ? "Done" : "Running..."}</Text>
            )}
          </Box>
        </Box>
      );
    }

    // Full mode: all details including live tool calls
    return (
      <Box flexDirection="column">
        {/* Main row: tree char + description + type + model + stats */}
        <Box flexDirection="row">
          <Text>
            <Text color={colors.subagent.treeChar}>
              {"   "}
              {treeChar}{" "}
            </Text>
            <Text bold>{agent.description}</Text>
            <Text dimColor>
              {" · "}
              {agent.type.toLowerCase()}
              {agent.model ? ` · ${agent.model}` : ""}
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

        {/* Expanded: show all tool calls */}
        {expanded &&
          agent.toolCalls.map((tc) => {
            const formattedArgs = formatToolArgs(tc.args);
            return (
              <Box key={tc.id} flexDirection="row">
                <Text color={colors.subagent.treeChar}>
                  {"   "}
                  {continueChar}
                </Text>
                <Text dimColor>
                  {"     "}
                  {tc.name}({formattedArgs})
                </Text>
              </Box>
            );
          })}

        {/* Status line */}
        <Box flexDirection="row">
          {agent.status === "completed" ? (
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
          ) : lastTool ? (
            <>
              <Text color={colors.subagent.treeChar}>
                {"   "}
                {continueChar}
              </Text>
              <Text dimColor>
                {"   "}
                {lastTool.name}
              </Text>
            </>
          ) : (
            <>
              <Text color={colors.subagent.treeChar}>
                {"   "}
                {continueChar}
              </Text>
              <Text dimColor>{"   Starting..."}</Text>
            </>
          )}
        </Box>
      </Box>
    );
  },
);
AgentRow.displayName = "AgentRow";

interface GroupHeaderProps {
  count: number;
  allCompleted: boolean;
  hasErrors: boolean;
  expanded: boolean;
  shouldAnimate?: boolean;
}

const GroupHeader = memo(
  ({
    count,
    allCompleted,
    hasErrors,
    expanded,
    shouldAnimate = true,
  }: GroupHeaderProps) => {
    const statusText = allCompleted
      ? `Ran ${count} subagent${count !== 1 ? "s" : ""}`
      : `Running ${count} subagent${count !== 1 ? "s" : ""}…`;

    const hint = expanded ? "(ctrl+o to collapse)" : "(ctrl+o to expand)";

    // Use error color for dot if any subagent errored
    const dotColor = hasErrors
      ? colors.subagent.error
      : colors.subagent.completed;

    return (
      <Box flexDirection="row">
        {allCompleted ? (
          <Text color={dotColor}>●</Text>
        ) : (
          <BlinkDot
            color={colors.subagent.header}
            shouldAnimate={shouldAnimate}
          />
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
  const terminalRows = useTerminalRows();

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

  // Overflow detection: disable animation when content would exceed viewport
  // This prevents Ink's clearTerminal flicker on every BlinkDot toggle
  const LINES_PER_AGENT = 4; // description + URL + status + margin
  const HEADER_LINES = 2; // header + some buffer for footer/input
  const FOOTER_BUFFER = 6; // input area, status bar, margins
  const expectedHeight =
    agents.length * LINES_PER_AGENT + HEADER_LINES + FOOTER_BUFFER;
  const wouldOverflow = expectedHeight >= terminalRows;
  const shouldAnimate = !wouldOverflow;

  const allCompleted = agents.every(
    (a) => a.status === "completed" || a.status === "error",
  );
  const hasErrors = agents.some((a) => a.status === "error");

  return (
    <Box flexDirection="column">
      <GroupHeader
        count={agents.length}
        allCompleted={allCompleted}
        hasErrors={hasErrors}
        expanded={expanded}
        shouldAnimate={shouldAnimate}
      />
      {agents.map((agent, index) => (
        <AgentRow
          key={agent.id}
          agent={agent}
          isLast={index === agents.length - 1}
          expanded={expanded}
          condensed={wouldOverflow}
        />
      ))}
    </Box>
  );
});

SubagentGroupDisplay.displayName = "SubagentGroupDisplay";
