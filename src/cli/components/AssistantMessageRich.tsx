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

type AssistantLine = {
  kind: "assistant";
  id: string;
  text: string;
  phase: "streaming" | "finished";
  isContinuation?: boolean;
};

/**
 * AssistantMessageRich - Rich formatting version with two-column layout
 * This is a direct port from the old letta-code codebase to preserve the exact styling
 *
 * Features:
 * - Left column (2 chars wide) with bullet point marker (unless continuation)
 * - Right column with wrapped text content
 * - Proper text normalization
 * - Support for markdown rendering (when MarkdownDisplay is available)
 */
export const AssistantMessage = memo(({ line }: { line: AssistantLine }) => {
  const columns = useTerminalWidth();
  const contentWidth = Math.max(0, columns - 2);
  const streamCfg = useTokenStreamingConfig();

  const normalizedText = normalize(line.text);
  if (!normalizedText.trim()) {
    return null;
  }

  const useTypewriterGlow =
    line.phase === "streaming" &&
    streamCfg.enabled &&
    streamCfg.style === "typewriter-glow";

  return (
    <Box flexDirection="row">
      <Box width={2} flexShrink={0}>
        <Text>{line.isContinuation ? " " : "●"}</Text>
      </Box>
      <Box flexGrow={1} width={contentWidth}>
        {useTypewriterGlow ? (
          <TypewriterGlowText text={normalizedText} />
        ) : (
          <MarkdownDisplay text={normalizedText} hangingIndent={0} />
        )}
      </Box>
    </Box>
  );
});

AssistantMessage.displayName = "AssistantMessage";
