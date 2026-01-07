import { Box, Text, useInput } from "ink";
import { memo, useState } from "react";
import { useTerminalWidth } from "../hooks/useTerminalWidth";
import { colors } from "./colors";

type Props = {
  onApprove: () => void;
  onApproveAndAcceptEdits: () => void;
  onKeepPlanning: (reason: string) => void;
  isFocused?: boolean;
};

/**
 * StaticPlanApproval - Options-only plan approval component
 *
 * This component renders ONLY the approval options (no plan preview).
 * The plan preview is committed separately to the Static area via the
 * eager commit pattern, which keeps this component small (~8 lines)
 * and flicker-free.
 *
 * The plan prop was removed because the plan is rendered in the Static
 * area by ApprovalPreview, not here.
 */
export const StaticPlanApproval = memo(
  ({
    onApprove,
    onApproveAndAcceptEdits,
    onKeepPlanning,
    isFocused = true,
  }: Props) => {
    const [selectedOption, setSelectedOption] = useState(0);
    const [customReason, setCustomReason] = useState("");
    const [cursorPos, setCursorPos] = useState(0);
    const columns = useTerminalWidth();

    const customOptionIndex = 2;
    const maxOptionIndex = customOptionIndex;
    const isOnCustomOption = selectedOption === customOptionIndex;
    const customOptionPlaceholder =
      "Type here to tell Letta Code what to change";

    useInput(
      (input, key) => {
        if (!isFocused) return;

        // CTRL-C: keep planning with cancel message
        if (key.ctrl && input === "c") {
          onKeepPlanning("User pressed CTRL-C to cancel");
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
          // Arrow key navigation within text
          if (key.leftArrow) {
            setCursorPos((prev) => Math.max(0, prev - 1));
            return;
          }
          if (key.rightArrow) {
            setCursorPos((prev) => Math.min(customReason.length, prev + 1));
            return;
          }

          if (key.return) {
            if (customReason.trim()) {
              onKeepPlanning(customReason.trim());
            }
            return;
          }
          if (key.escape) {
            if (customReason) {
              setCustomReason("");
              setCursorPos(0);
            } else {
              onKeepPlanning("User cancelled");
            }
            return;
          }
          // Backspace: delete character before cursor
          if (key.backspace || key.delete) {
            if (cursorPos > 0) {
              setCustomReason(
                (prev) => prev.slice(0, cursorPos - 1) + prev.slice(cursorPos),
              );
              setCursorPos((prev) => prev - 1);
            }
            return;
          }
          // Typing: insert at cursor position
          if (input && !key.ctrl && !key.meta && input.length === 1) {
            setCustomReason(
              (prev) =>
                prev.slice(0, cursorPos) + input + prev.slice(cursorPos),
            );
            setCursorPos((prev) => prev + 1);
          }
          return;
        }

        // When on regular options
        if (key.return) {
          if (selectedOption === 0) {
            onApproveAndAcceptEdits();
          } else if (selectedOption === 1) {
            onApprove();
          }
          return;
        }
        if (key.escape) {
          onKeepPlanning("User cancelled");
        }
      },
      { isActive: isFocused },
    );

    // Hint text based on state
    const hintText = isOnCustomOption
      ? customReason
        ? "Enter to submit · Esc to clear"
        : "Type feedback · Esc to cancel"
      : "Enter to select · Esc to cancel";

    return (
      <Box flexDirection="column">
        {/* Question */}
        <Box>
          <Text>Would you like to proceed?</Text>
        </Box>

        {/* Options */}
        <Box marginTop={1} flexDirection="column">
          {/* Option 1: Yes, and auto-accept edits */}
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
                Yes, and auto-accept edits
              </Text>
            </Box>
          </Box>

          {/* Option 2: Yes, and manually approve edits */}
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
                Yes, and manually approve edits
              </Text>
            </Box>
          </Box>

          {/* Option 3: Custom input */}
          <Box flexDirection="row">
            <Box width={5} flexShrink={0}>
              <Text
                color={isOnCustomOption ? colors.approval.header : undefined}
              >
                {isOnCustomOption ? "❯" : " "} 3.
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

StaticPlanApproval.displayName = "StaticPlanApproval";
