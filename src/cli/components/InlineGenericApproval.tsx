import { Box, Text, useInput } from "ink";
import { memo, useMemo, useState } from "react";
import { useProgressIndicator } from "../hooks/useProgressIndicator";
import { useTerminalWidth } from "../hooks/useTerminalWidth";
import { useTextInputCursor } from "../hooks/useTextInputCursor";
import { colors } from "./colors";

type Props = {
  toolName: string;
  toolArgs: string;
  onApprove: () => void;
  onApproveAlways: (scope: "project" | "session") => void;
  onDeny: (reason: string) => void;
  onCancel?: () => void;
  isFocused?: boolean;
  approveAlwaysText?: string;
  allowPersistence?: boolean;
};

// Horizontal line character for Claude Code style
const SOLID_LINE = "─";

/**
 * Format tool arguments for display
 */
function formatArgs(toolArgs: string): string {
  try {
    const parsed = JSON.parse(toolArgs);
    // Pretty print with 2-space indent, but limit length
    const formatted = JSON.stringify(parsed, null, 2);
    // Truncate if too long
    if (formatted.length > 500) {
      return `${formatted.slice(0, 500)}\n...`;
    }
    return formatted;
  } catch {
    // If not valid JSON, return as-is
    return toolArgs || "(no arguments)";
  }
}

/**
 * InlineGenericApproval - Renders generic tool approval UI inline
 *
 * Used as fallback for any tool not handled by specialized inline components.
 */
export const InlineGenericApproval = memo(
  ({
    toolName,
    toolArgs,
    onApprove,
    onApproveAlways,
    onDeny,
    onCancel,
    isFocused = true,
    approveAlwaysText,
    allowPersistence = true,
  }: Props) => {
    const [selectedOption, setSelectedOption] = useState(0);
    const {
      text: customReason,
      cursorPos,
      handleKey,
      clear,
    } = useTextInputCursor();
    const columns = useTerminalWidth();
    useProgressIndicator();

    // Custom option index depends on whether "always" option is shown
    const customOptionIndex = allowPersistence ? 2 : 1;
    const maxOptionIndex = customOptionIndex;
    const isOnCustomOption = selectedOption === customOptionIndex;
    const customOptionPlaceholder =
      "No, and tell Letta Code what to do differently";

    useInput(
      (input, key) => {
        if (!isFocused) return;

        // CTRL-C: cancel (queue denial, return to input)
        if (key.ctrl && input === "c") {
          onCancel?.();
          return;
        }

        // Arrow navigation always works
        if (key.upArrow) {
          setSelectedOption((prev) => Math.max(0, prev - 1));
          return;
        }
        if (key.downArrow) {
          setSelectedOption((prev) => Math.min(maxOptionIndex, prev + 1));
          return;
        }

        // When on custom input option
        if (isOnCustomOption) {
          if (key.return) {
            if (customReason.trim()) {
              onDeny(customReason.trim());
            }
            return;
          }
          if (key.escape) {
            if (customReason) {
              clear();
            } else {
              onCancel?.();
            }
            return;
          }
          // Handle text input (arrows, backspace, typing)
          if (handleKey(input, key)) return;
        }

        // When on regular options
        if (key.return) {
          if (selectedOption === 0) {
            onApprove();
          } else if (selectedOption === 1 && allowPersistence) {
            onApproveAlways("project");
          }
          return;
        }
        if (key.escape) {
          onCancel?.();
        }
      },
      { isActive: isFocused },
    );

    // Generate horizontal line
    const solidLine = SOLID_LINE.repeat(Math.max(columns, 10));
    const formattedArgs = formatArgs(toolArgs);

    // Memoize the static tool content so it doesn't re-render on keystroke
    // This prevents flicker when typing feedback in the custom input field
    const memoizedToolContent = useMemo(
      () => (
        <>
          {/* Top solid line */}
          <Text dimColor>{solidLine}</Text>

          {/* Header */}
          <Text bold color={colors.approval.header}>
            Run {toolName}?
          </Text>

          <Box height={1} />

          {/* Arguments preview */}
          <Box paddingLeft={2} flexDirection="column">
            <Text dimColor>{formattedArgs}</Text>
          </Box>
        </>
      ),
      [toolName, formattedArgs, solidLine],
    );

    // Hint text based on state
    const hintText = isOnCustomOption
      ? customReason
        ? "Enter to submit · Esc to clear"
        : "Type reason · Esc to cancel"
      : "Enter to select · Esc to cancel";

    return (
      <Box flexDirection="column">
        {/* Static tool content - memoized to prevent re-render on keystroke */}
        {memoizedToolContent}

        {/* Options */}
        <Box marginTop={1} flexDirection="column">
          {/* Option 1: Yes */}
          <Box flexDirection="row">
            <Box width={5} flexShrink={0}>
              <Text
                color={
                  selectedOption === 0 ? colors.approval.header : undefined
                }
              >
                {selectedOption === 0 ? "❯" : " "} 1.
              </Text>
            </Box>
            <Box flexGrow={1} width={Math.max(0, columns - 5)}>
              <Text
                wrap="wrap"
                color={
                  selectedOption === 0 ? colors.approval.header : undefined
                }
              >
                Yes
              </Text>
            </Box>
          </Box>

          {/* Option 2: Yes, always (only if persistence allowed) */}
          {allowPersistence && (
            <Box flexDirection="row">
              <Box width={5} flexShrink={0}>
                <Text
                  color={
                    selectedOption === 1 ? colors.approval.header : undefined
                  }
                >
                  {selectedOption === 1 ? "❯" : " "} 2.
                </Text>
              </Box>
              <Box flexGrow={1} width={Math.max(0, columns - 5)}>
                <Text
                  wrap="wrap"
                  color={
                    selectedOption === 1 ? colors.approval.header : undefined
                  }
                >
                  {approveAlwaysText ||
                    "Yes, and don't ask again for this project"}
                </Text>
              </Box>
            </Box>
          )}

          {/* Custom input option */}
          <Box flexDirection="row">
            <Box width={5} flexShrink={0}>
              <Text
                color={isOnCustomOption ? colors.approval.header : undefined}
              >
                {isOnCustomOption ? "❯" : " "} {customOptionIndex + 1}.
              </Text>
            </Box>
            <Box flexGrow={1} width={Math.max(0, columns - 5)}>
              {customReason ? (
                <Text wrap="wrap">
                  {customReason.slice(0, cursorPos)}
                  {isOnCustomOption && "█"}
                  {customReason.slice(cursorPos)}
                </Text>
              ) : (
                <Text wrap="wrap" dimColor>
                  {customOptionPlaceholder}
                  {isOnCustomOption && "█"}
                </Text>
              )}
            </Box>
          </Box>
        </Box>

        {/* Hint */}
        <Box marginTop={1}>
          <Text dimColor>{hintText}</Text>
        </Box>
      </Box>
    );
  },
);

InlineGenericApproval.displayName = "InlineGenericApproval";
