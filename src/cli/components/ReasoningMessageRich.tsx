import { Box } from "ink";
import { memo } from "react";
import { useTokenStreamingConfig } from "../contexts/StreamingTextContext";
import { useTerminalWidth } from "../hooks/useTerminalWidth";
import { MarkdownDisplay } from "./MarkdownDisplay.js";
import { Text } from "./Text";
import { TypewriterGlowText } from "./TypewriterGlowText";

// Helper function to normalize text - copied from old codebase
// NOTE: Less aggressive than before to preserve spacing when content is split across chunks
const normalize = (s: string) =>
  s
    .replace(/\r\n/g, "\n")
    // Normalize stray CRs that can slip in via streaming or provider responses.
    .replace(/\r/g, "\n")
    // Treat whitespace-only lines as blank lines so we can reliably collapse
    // excessive paragraph spacing even when the model emits indented "empty" lines.
    // Use a broad whitespace class (excluding newlines) to catch non-breaking spaces too.
    .replace(/^[^\S\n]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/g, ""); // Only trim leading newlines, preserve trailing ones

type ReasoningLine = {
  kind: "reasoning";
  id: string;
  text: string;
  phase: "streaming" | "finished";
  isContinuation?: boolean;
};

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
export const ReasoningMessage = memo(({ line }: { line: ReasoningLine }) => {
  const columns = useTerminalWidth();
  const contentWidth = Math.max(0, columns - 2);
  const streamCfg = useTokenStreamingConfig();

  const normalizedText = normalize(line.text);

  const useTypewriterGlow =
    line.phase === "streaming" &&
    streamCfg.enabled &&
    streamCfg.style === "typewriter-glow";

  // Continuation lines skip the header, just show content
  if (line.isContinuation) {
    return (
      <Box flexDirection="row">
        <Box width={2} flexShrink={0}>
          <Text> </Text>
        </Box>
        <Box flexGrow={1} width={contentWidth}>
          {useTypewriterGlow ? (
            <TypewriterGlowText text={normalizedText} dimColor={true} />
          ) : (
            <MarkdownDisplay text={normalizedText} dimColor={true} />
          )}
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
          <Text dimColor>Thinking…</Text>
        </Box>
      </Box>
      <Box height={1} />
      <Box flexDirection="row">
        <Box width={2} flexShrink={0}>
          <Text> </Text>
        </Box>
        <Box flexGrow={1} width={contentWidth}>
          {useTypewriterGlow ? (
            <TypewriterGlowText text={normalizedText} dimColor={true} />
          ) : (
            <MarkdownDisplay text={normalizedText} dimColor={true} />
          )}
        </Box>
      </Box>
    </Box>
  );
});

ReasoningMessage.displayName = "ReasoningMessage";
