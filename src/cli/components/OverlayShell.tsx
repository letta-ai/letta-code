// Shared shell for overlay UIs.
// Renders the "> /command" header, solid line, title, and optional footer.
// Every overlay selector/dialog uses this pattern.

import { Box } from "ink";
import type { ReactNode } from "react";
import { useTerminalWidth } from "@/cli/hooks/use-terminal-width";
import { colors } from "./colors";
import { Text } from "./Text";

const SOLID_LINE = "─";

interface OverlayShellProps {
  /** The command that opened this overlay, e.g. "/personality" */
  command: string;
  /** Title displayed below the solid line */
  title: string;
  children: ReactNode;
  /** Optional footer content (e.g. hint line). If omitted, no footer is rendered. */
  footer?: ReactNode;
}

export function OverlayShell({
  command,
  title,
  children,
  footer,
}: OverlayShellProps) {
  const terminalWidth = useTerminalWidth();
  const solidLine = SOLID_LINE.repeat(Math.max(terminalWidth, 10));
  const renderedFooter =
    typeof footer === "string" || typeof footer === "number" ? (
      <Text dimColor>{footer}</Text>
    ) : (
      footer
    );

  return (
    <Box flexDirection="column">
      <Text dimColor>{`> ${command}`}</Text>
      <Text dimColor>{solidLine}</Text>

      <Box height={1} />

      <Box marginBottom={1}>
        <Text bold color={colors.selector.title}>
          {title}
        </Text>
      </Box>

      {children}

      {footer && <Box marginTop={1}>{renderedFooter}</Box>}
    </Box>
  );
}
