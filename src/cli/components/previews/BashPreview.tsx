import { Box } from "ink";
import { memo } from "react";
import { colors } from "@/cli/components/colors";
import { SyntaxHighlightedCommand } from "@/cli/components/SyntaxHighlightedCommand";
import { Text } from "@/cli/components/Text";
import { useTerminalWidth } from "@/cli/hooks/use-terminal-width";

const SOLID_LINE = "─";
const BASH_PREVIEW_MAX_LINES = 3;

type Props = {
  command: string;
  description?: string;
};

/**
 * BashPreview - Renders the bash command preview (no interactive options)
 *
 * Used by:
 * - InlineBashApproval for memoized content
 * - Static area for eagerly-committed command previews
 */
export const BashPreview = memo(({ command, description }: Props) => {
  const columns = useTerminalWidth();
  const solidLine = SOLID_LINE.repeat(Math.max(columns, 10));

  return (
    <>
      {/* Top solid line */}
      <Text dimColor>{solidLine}</Text>

      {/* Header */}
      <Text bold color={colors.approval.header}>
        Run this command?
      </Text>

      <Box height={1} />

      {/* Command preview */}
      <Box paddingLeft={2} flexDirection="column">
        <SyntaxHighlightedCommand
          command={command}
          maxLines={BASH_PREVIEW_MAX_LINES}
          maxColumns={Math.max(10, columns - 2)}
          showTruncationHint
        />
        {description && <Text dimColor>{description}</Text>}
      </Box>
    </>
  );
});

BashPreview.displayName = "BashPreview";
