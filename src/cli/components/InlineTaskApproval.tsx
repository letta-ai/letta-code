import { Box, Text, useInput } from "ink";
import { memo, useMemo, useState } from "react";
import { useTerminalWidth } from "../hooks/useTerminalWidth";
import { useTextInputCursor } from "../hooks/useTextInputCursor";
import { colors } from "./colors";

type Props = {
  taskInfo: {
    subagentType: string;
    description: string;
    prompt: string;
    model?: string;
  };
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
 * Truncate text to max length with ellipsis
 */
function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3)}...`;
}

/**
 * InlineTaskApproval - Renders Task tool approval UI inline with pretty formatting
 *
 * Shows subagent type, description, and prompt in a readable format.
 */
export const InlineTaskApproval = memo(
  ({
    taskInfo,
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
            onApproveAlways("session");
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
    const solidLine = SOLID_LINE.repeat(Math.max(columns - 2, 10));
    const contentWidth = Math.max(0, columns - 4); // 2 padding on each side

    // Memoize the static task content so it doesn't re-render on keystroke
    const memoizedTaskContent = useMemo(() => {
      const { subagentType, description, prompt, model } = taskInfo;

      // Truncate prompt if too long (show first ~200 chars)
      const truncatedPrompt = truncate(prompt, 300);

      return (
        <>
          {/* Top solid line */}
          <Text dimColor>{solidLine}</Text>

          {/* Header */}
          <Text bold color={colors.approval.header}>
            Run Task?
          </Text>

          {/* Task details */}
          <Box paddingLeft={2} flexDirection="column" marginTop={1}>
            {/* Subagent type */}
            <Box flexDirection="row">
              <Box width={12} flexShrink={0}>
                <Text dimColor>Type:</Text>
              </Box>
              <Box flexGrow={1} width={contentWidth - 12}>
                <Text wrap="wrap" color={colors.subagent.header}>
                  {subagentType}
                </Text>
              </Box>
            </Box>

            {/* Model (if specified) */}
            {model && (
              <Box flexDirection="row">
                <Box width={12} flexShrink={0}>
                  <Text dimColor>Model:</Text>
                </Box>
                <Box flexGrow={1} width={contentWidth - 12}>
                  <Text wrap="wrap" dimColor>
                    {model}
                  </Text>
                </Box>
              </Box>
            )}

            {/* Description */}
            <Box flexDirection="row">
              <Box width={12} flexShrink={0}>
                <Text dimColor>Description:</Text>
              </Box>
              <Box flexGrow={1} width={contentWidth - 12}>
                <Text wrap="wrap">{description}</Text>
              </Box>
            </Box>

            {/* Prompt */}
            <Box flexDirection="row" marginTop={1}>
              <Box width={12} flexShrink={0}>
                <Text dimColor>Prompt:</Text>
              </Box>
              <Box flexGrow={1} width={contentWidth - 12}>
                <Text wrap="wrap" dimColor>
                  {truncatedPrompt}
                </Text>
              </Box>
            </Box>
          </Box>
        </>
      );
    }, [taskInfo, solidLine, contentWidth]);

    // Hint text based on state
    const hintText = isOnCustomOption
      ? customReason
        ? "Enter to submit · Esc to clear"
        : "Type reason · Esc to cancel"
      : "Enter to select · Esc to cancel";

    // Generate "always" text for Task tool
    const alwaysText =
      approveAlwaysText || "Yes, allow Task operations during this session";

    return (
      <Box flexDirection="column">
        {/* Static task content - memoized to prevent re-render on keystroke */}
        {memoizedTaskContent}

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
                  {alwaysText}
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
                <Text wrap="wrap" dimColor={!isOnCustomOption}>
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

InlineTaskApproval.displayName = "InlineTaskApproval";
