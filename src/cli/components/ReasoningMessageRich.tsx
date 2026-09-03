import { Box } from "ink";
import { memo, useSyncExternalStore } from "react";
import stringWidth from "string-width";
import {
  useTerminalRows,
  useTerminalWidth,
} from "@/cli/hooks/use-terminal-width";
import { MarkdownDisplay } from "./MarkdownDisplay.js";
import { Text } from "./Text";
import {
  getThinkingExpanded,
  subscribeToThinkingDisplay,
} from "./transcript-display-state";

// Helper function to normalize text - copied from old codebase
// NOTE: Less aggressive than before to preserve spacing when content is split across chunks
const normalize = (s: string) =>
  s
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/g, ""); // Only trim leading newlines, preserve trailing ones

type ReasoningLine = {
  kind: "reasoning";
  id: string;
  text: string;
  phase: "streaming" | "finished";
  isContinuation?: boolean;
  durationMs?: number;
};

const LIVE_REASONING_MAX_LINES = 16;
const LIVE_REASONING_CHROME_ROWS = 8;

export function getLiveReasoningWindowHeight(
  text: string,
  contentWidth: number,
  terminalRows: number,
): number {
  const width = Math.max(1, contentWidth);
  const estimatedLines = text.split("\n").reduce((total, line) => {
    return total + Math.max(1, Math.ceil(stringWidth(line) / width));
  }, 0);
  const availableRows = Math.max(3, terminalRows - LIVE_REASONING_CHROME_ROWS);
  return Math.min(estimatedLines, LIVE_REASONING_MAX_LINES, availableRows);
}

export function formatThinkingDuration(durationMs: number): string {
  const seconds = Math.max(1, Math.round(durationMs / 1000));
  return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
}

/**
 * ReasoningMessageRich - Rich formatting version with special reasoning layout
 * This is a direct port from the old letta-code codebase to preserve the exact styling
 *
 * Features:
 * - Header row with "✻" symbol and "Thinking…" text (unless continuation)
 * - Reasoning content indented with 2 spaces
 * - Full markdown rendering with dimmed colors
 * - Proper text normalization
 */
export const ReasoningMessage = memo(
  ({ line, expanded = false }: { line: ReasoningLine; expanded?: boolean }) => {
    const columns = useTerminalWidth();
    const terminalRows = useTerminalRows();
    const contentWidth = Math.max(0, columns - 2);

    const normalizedText = normalize(line.text);

    // Continuation rows belong to the preceding thinking block. Keep them
    // hidden with that block rather than emitting extra collapsed headers.
    if (line.isContinuation) {
      if (!expanded) return null;
      return (
        <Box flexDirection="row">
          <Box width={2} flexShrink={0}>
            <Text> </Text>
          </Box>
          <Box flexGrow={1} width={contentWidth}>
            <MarkdownDisplay text={normalizedText} dimColor={true} />
          </Box>
        </Box>
      );
    }

    const isStreaming = line.phase === "streaming";
    const glyph = expanded ? "▾" : isStreaming ? "✻" : "▸";
    const label = isStreaming
      ? "Thinking…"
      : line.durationMs === undefined
        ? "Thought"
        : `Thought for ${formatThinkingDuration(line.durationMs)}`;
    const hint = expanded ? "collapse" : "expand";
    const reasoningBody = (
      <Box flexDirection="row" flexShrink={0}>
        <Box width={2} flexShrink={0}>
          <Text> </Text>
        </Box>
        <Box flexGrow={1} width={contentWidth}>
          <MarkdownDisplay text={normalizedText} dimColor={true} />
        </Box>
      </Box>
    );

    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Box width={2} flexShrink={0}>
            <Text dimColor>{glyph}</Text>
          </Box>
          <Box flexGrow={1} width={contentWidth}>
            <Text dimColor>
              {label} (ctrl+t to {hint})
            </Text>
          </Box>
        </Box>
        {expanded && <Box height={1} />}
        {expanded && isStreaming ? (
          <Box
            flexDirection="column"
            height={getLiveReasoningWindowHeight(
              normalizedText,
              contentWidth,
              terminalRows,
            )}
            justifyContent="flex-end"
            overflowY="hidden"
          >
            {reasoningBody}
          </Box>
        ) : expanded ? (
          reasoningBody
        ) : null}
      </Box>
    );
  },
);

export const LiveReasoningMessage = memo(
  ({ line }: { line: ReasoningLine }) => {
    const expanded = useSyncExternalStore(
      subscribeToThinkingDisplay,
      getThinkingExpanded,
    );
    return <ReasoningMessage line={line} expanded={expanded} />;
  },
);

ReasoningMessage.displayName = "ReasoningMessage";
LiveReasoningMessage.displayName = "LiveReasoningMessage";
