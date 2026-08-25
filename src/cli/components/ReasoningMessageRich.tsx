import { Box } from "ink";
import { memo, useSyncExternalStore } from "react";
import { useTerminalWidth } from "@/cli/hooks/use-terminal-width";
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
        {expanded && (
          <Box flexDirection="row">
            <Box width={2} flexShrink={0}>
              <Text> </Text>
            </Box>
            <Box flexGrow={1} width={contentWidth}>
              <MarkdownDisplay text={normalizedText} dimColor={true} />
            </Box>
          </Box>
        )}
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
