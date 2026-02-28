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

import { Box, useInput } from "ink";
import { memo, useSyncExternalStore } from "react";
import { useAnimation } from "../contexts/AnimationContext.js";
import {
  formatStats,
  getSubagentModelDisplay,
  getTreeChars,
} from "../helpers/subagentDisplay.js";
import {
  getSnapshot,
  type SubagentState,
  subscribe,
  toggleExpanded,
} from "../helpers/subagentState.js";
import { useTerminalWidth } from "../hooks/useTerminalWidth.js";
import { BlinkDot } from "./BlinkDot.js";
import { colors } from "./colors.js";
import { Text } from "./Text";

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
    const shouldDim = isRunning && !agent.isBackground;
    const showStats = !(agent.isBackground && isRunning);
    const hideBackgroundStatusLine =
      agent.isBackground && isRunning && !agent.agentURL;
    const stats = formatStats(
      agent.toolCalls.length,
      agent.totalTokens,
      isRunning,
    );
    const modelDisplay = getSubagentModelDisplay(agent.model);
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
                  {modelDisplay.isByokProvider && (
                    <Text
                      color={
                        modelDisplay.isOpenAICodexProvider
                          ? "#74AA9C"
                          : "yellow"
                      }
                    >
                      {" ▲"}
                    </Text>
                  )}
                </>
              )}
            </Text>
          </Box>
          {/* Simple status line */}
          {!hideBackgroundStatusLine && (
            <Box flexDirection="row">
              <Text color={colors.subagent.treeChar}>
                {"   "}
                {continueChar}
              </Text>
              <Text dimColor>{"   "}</Text>
              {agent.status === "error" ? (
                <Text color={colors.subagent.error}>Error</Text>
              ) : isComplete ? (
                <Text dimColor>Done</Text>
              ) : agent.isBackground ? (
                <Text dimColor>Running in the background</Text>
              ) : (
                <Text dimColor>Running...</Text>
              )}
            </Box>
          )}
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
            {showStats && (
              <Text dimColor>
                {" · "}
                {stats}
              </Text>
            )}
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
        {!hideBackgroundStatusLine && (
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
            ) : agent.isBackground ? (
              <Text>
                <Text color={colors.subagent.treeChar}>
                  {"   "}
                  {continueChar}
                </Text>
                <Text dimColor>{"   Running in the background"}</Text>
              </Text>
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
        )}
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
}

const GroupHeader = memo(
  ({ count, allCompleted, hasErrors, expanded }: GroupHeaderProps) => {
    const hint = expanded ? "(ctrl+o to collapse)" : "(ctrl+o to expand)";

    const dotColor = hasErrors
      ? colors.subagent.error
      : colors.subagent.completed;
    const runningDotColor = hasErrors
      ? colors.subagent.error
      : colors.tool.pending;
    const label = allCompleted ? "Ran" : "Running";
    const suffix = count !== 1 ? "agents" : "agent";

    return (
      <Box flexDirection="row">
        {allCompleted ? (
          <Text color={dotColor}>●</Text>
        ) : (
          // BlinkDot now gets shouldAnimate from AnimationContext
          <BlinkDot color={runningDotColor} />
        )}
        <Text>
          {" "}
          {label} <Text bold>{count}</Text> {suffix}
        </Text>
        <Text color={colors.subagent.hint}> {hint}</Text>
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
  const { shouldAnimate } = useAnimation();

  // Handle ctrl+o for expand/collapse
  useInput((input, key) => {
    if (key.ctrl && input === "o") {
      toggleExpanded();
    }
  });

  // Hide silent subagents (e.g. init) — they handle user notifications
  // via their own mechanisms (e.g. EventMessage).
  const visible = agents.filter((a) => !a.silent);

  // Don't render if no agents
  if (visible.length === 0) {
    return null;
  }

  // Use condensed mode when animation is disabled (overflow detected by AnimationContext)
  // This ensures consistent behavior - when we disable animation, we also simplify the view
  const condensed = !shouldAnimate;

  const allCompleted = visible.every(
    (a) => a.status === "completed" || a.status === "error",
  );
  const hasErrors = visible.some((a) => a.status === "error");

  return (
    <Box flexDirection="column" marginTop={1}>
      <GroupHeader
        count={visible.length}
        allCompleted={allCompleted}
        hasErrors={hasErrors}
        expanded={expanded}
      />
      {visible.map((agent, index) => (
        <AgentRow
          key={agent.id}
          agent={agent}
          isLast={index === visible.length - 1}
          expanded={expanded}
          condensed={condensed}
        />
      ))}
    </Box>
  );
});

SubagentGroupDisplay.displayName = "SubagentGroupDisplay";
