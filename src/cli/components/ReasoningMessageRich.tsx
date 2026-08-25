import { Box } from "ink";
import { memo } from "react";
import { useReasoningDisplay } from "@/cli/app/use-reasoning-display";
import {
  reasoningSpanOf,
  useReasoningTick,
} from "@/cli/helpers/reasoning-timing";
import { useTerminalWidth } from "@/cli/hooks/use-terminal-width";
import { MarkdownDisplay } from "./MarkdownDisplay.js";
import { Text } from "./Text";

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
  messageId?: string;
};

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * Elapsed time for a reasoning block. Driven by the shared one-second
 * ticker (see reasoning-timing.ts) — no per-component timers.
 */
function Elapsed({
  startedAt,
  endedAt,
}: {
  startedAt?: number;
  endedAt?: number;
}) {
  useReasoningTick();

  if (!startedAt) return null;
  const end = endedAt ?? Date.now();
  return <Text dimColor>({formatElapsed(end - startedAt)})</Text>;
}

/**
 * ReasoningMessageRich — collapsed-by-default spoiler view.
 *
 * Streaming and finished reasoning blocks render as a single dim line
 * ("thinking"/"thinked" + elapsed time) so long thought streams don't flood
 * the transcript. ctrl+t (see use-reasoning-display.ts) expands every block
 * into its full markdown text.
 *
 * Elapsed time comes from reasoning-timing.ts keyed by messageId, so every
 * line of a split block renders the same duration.
 */
export const ReasoningMessage = memo(({ line }: { line: ReasoningLine }) => {
  const columns = useTerminalWidth();
  const contentWidth = Math.max(0, columns - 2);
  const expanded = useReasoningDisplay();
  const span = reasoningSpanOf(line.messageId) ?? reasoningSpanOf(line.id);

  // Continuation lines are split-off tails of a block; they only carry
  // visible content in expanded mode.
  if (line.isContinuation && !expanded) return null;

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Box width={2} flexShrink={0}>
          <Text dimColor>✻</Text>
        </Box>
        <Box flexGrow={1} width={contentWidth}>
          <Text dimColor>
            {line.phase === "streaming" ? "thinking" : "thinked"}{" "}
          </Text>
          <Elapsed {...span} />
        </Box>
      </Box>
      {expanded ? (
        <>
          <ToggleHint expanded={true} />
          <Box height={1} />
          <Box flexDirection="row">
            <Box width={2} flexShrink={0}>
              <Text> </Text>
            </Box>
            <Box flexGrow={1} width={contentWidth}>
              <MarkdownDisplay text={normalize(line.text)} dimColor={true} />
            </Box>
          </Box>
        </>
      ) : (
        <ToggleHint expanded={false} />
      )}
    </Box>
  );
});

function ToggleHint({ expanded }: { expanded: boolean }) {
  return (
    <Box flexDirection="row">
      <Box width={2} flexShrink={0}>
        <Text> </Text>
      </Box>
      <Text dimColor>(ctrl+t to {expanded ? "collapse" : "expand"})</Text>
    </Box>
  );
}

ReasoningMessage.displayName = "ReasoningMessage";
