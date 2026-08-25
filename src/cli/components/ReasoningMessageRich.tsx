import { Box } from "ink";
import { memo } from "react";
import { useReasoningDisplay } from "@/cli/app/use-reasoning-display";
import {
  reasoningSpanOf,
  traceRender,
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
 * Elapsed time for a still-streaming block: the only case that needs the
 * shared ticker. Finished blocks render a frozen duration with no
 * subscription at all — a long transcript must not re-render every second.
 */
function TickingElapsed({ startedAt }: { startedAt: number }) {
  useReasoningTick();
  traceRender("ticking", `startedAt=${startedAt}`);
  return <Text dimColor>({formatElapsed(Date.now() - startedAt)})</Text>;
}

function Elapsed({
  startedAt,
  endedAt,
}: {
  startedAt?: number;
  endedAt?: number;
}) {
  if (!startedAt) return null;
  if (endedAt !== undefined) {
    traceRender("frozen", `dur=${endedAt - startedAt}`);
    return <Text dimColor>({formatElapsed(endedAt - startedAt)})</Text>;
  }
  return <TickingElapsed startedAt={startedAt} />;
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
/**
 * Span for a line: by messageId, own id, or — for split lines created
 * before a messageId arrived — by recovering the block id from the
 * "<blockId>-split-<N>" naming convention.
 */
function spanOfLine(line: ReasoningLine) {
  return (
    reasoningSpanOf(line.messageId) ??
    reasoningSpanOf(line.id) ??
    reasoningSpanOf(line.id.split("-split-")[0])
  );
}

/**
 * Phase label follows the whole block (span frozen?), not the individual
 * line: a freshly split-off part carries line.phase === "finished" while
 * the thought is still streaming.
 */
function phaseLabel(line: ReasoningLine, span?: { endedAt?: number }): string {
  if (span?.endedAt !== undefined) return "thinked";
  return line.phase === "finished" && !line.isContinuation
    ? "thinked"
    : "thinking";
}

export const ReasoningMessage = memo(({ line }: { line: ReasoningLine }) => {
  const columns = useTerminalWidth();
  const contentWidth = Math.max(0, columns - 2);
  const expanded = useReasoningDisplay();
  const span = spanOfLine(line);
  const label = phaseLabel(line, span);

  // Split-off tails of a block: hidden when collapsed, plain text when
  // expanded — the block's single header lives on its first line only.
  if (line.isContinuation) {
    if (!expanded) return null;
    return (
      <Box flexDirection="row">
        <Box width={2} flexShrink={0}>
          <Text> </Text>
        </Box>
        <Box flexGrow={1} width={contentWidth}>
          <MarkdownDisplay text={normalize(line.text)} dimColor={true} />
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Box width={2} flexShrink={0}>
          <Text dimColor>✻</Text>
        </Box>
        <Box flexGrow={1} width={contentWidth}>
          <Text dimColor>{label} </Text>
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
