import { Box, Text } from "ink";
import { memo } from "react";
import { useTerminalWidth } from "../../hooks/useTerminalWidth";
import { colors } from "../colors";

const SOLID_LINE = "─";

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
        <Text>{command}</Text>
        {description && <Text dimColor>{description}</Text>}
      </Box>
    </>
  );
});

BashPreview.displayName = "BashPreview";
