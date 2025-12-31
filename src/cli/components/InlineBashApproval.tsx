import { Box, Text, useInput } from "ink";
import { memo, useState } from "react";
import { useTerminalWidth } from "../hooks/useTerminalWidth";
import { colors } from "./colors";

type BashInfo = {
  toolName: string;
  command: string;
  description?: string;
};

type Props = {
  bashInfo: BashInfo;
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
 * InlineBashApproval - Renders bash/shell approval UI inline (Claude Code style)
 *
 * Option 3 is an inline text input - when selected, user can type directly
 * without switching to a separate screen.
 */
export const InlineBashApproval = memo(
  ({
    bashInfo,
    onApprove,
    onApproveAlways,
    onDeny,
    onCancel,
    isFocused = true,
    approveAlwaysText,
    allowPersistence = true,
  }: Props) => {
    const [selectedOption, setSelectedOption] = useState(0);
    const [customReason, setCustomReason] = useState("");
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
              // User typed a reason - send it
              onDeny(customReason.trim());
            }
            // If empty, do nothing (can't submit empty reason)
            return;
          }
          if (key.escape) {
            if (customReason) {
              // Clear text first
              setCustomReason("");
            } else {
              // No text, cancel (queue denial, return to input)
              onCancel?.();
            }
            return;
          }
          if (key.backspace || key.delete) {
            setCustomReason((prev) => prev.slice(0, -1));
            return;
          }
          // Printable characters - append to custom reason
          if (input && !key.ctrl && !key.meta && input.length === 1) {
            setCustomReason((prev) => prev + input);
          }
          return;
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
          // Cancel (queue denial, return to input)
          onCancel?.();
        }
      },
      { isActive: isFocused },
    );

    const solidLine = SOLID_LINE.repeat(Math.max(columns - 2, 10));

    // Hint text based on state
    const hintText = isOnCustomOption
      ? customReason
        ? "Enter to submit · Esc to clear"
        : "Type reason · Esc to cancel"
      : "Enter to select · Esc to cancel";

    return (
      <Box flexDirection="column">
        {/* Top solid line */}
        <Text dimColor>{solidLine}</Text>

        {/* Header */}
        <Text bold color={colors.approval.header}>
          Run this command?
        </Text>

        <Box height={1} />

        {/* Command preview */}
        <Box paddingLeft={2} flexDirection="column">
          <Text>{bashInfo.command}</Text>
          {bashInfo.description && <Text dimColor>{bashInfo.description}</Text>}
        </Box>

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

          {/* Custom input option (3 if persistence, 2 if not) */}
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
                  {customReason}
                  {isOnCustomOption && "█"}
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

InlineBashApproval.displayName = "InlineBashApproval";
