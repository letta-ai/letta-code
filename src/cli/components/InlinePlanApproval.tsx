import { Box, Text, useInput } from "ink";
import { memo, useMemo, useState } from "react";
import { useProgressIndicator } from "../hooks/useProgressIndicator";
import { useTerminalWidth } from "../hooks/useTerminalWidth";
import { useTextInputCursor } from "../hooks/useTextInputCursor";
import { colors } from "./colors";
import { MarkdownDisplay } from "./MarkdownDisplay";

type Props = {
  plan: string;
  onApprove: () => void;
  onApproveAndAcceptEdits: () => void;
  onKeepPlanning: (reason: string) => void;
  isFocused?: boolean;
};

// Horizontal line characters for Claude Code style
const SOLID_LINE = "─";
const DOTTED_LINE = "╌";

/**
 * InlinePlanApproval - Renders plan approval UI inline (Claude Code style)
 *
 * Uses horizontal lines instead of boxes for visual styling:
 * - ──── solid line at top
 * - ╌╌╌╌ dotted line around plan content
 * - Approval options below
 */
export const InlinePlanApproval = memo(
  ({
    plan,
    onApprove,
    onApproveAndAcceptEdits,
    onKeepPlanning,
    isFocused = true,
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
          if (key.return) {
            if (customReason.trim()) {
              onKeepPlanning(customReason.trim());
            }
            return;
          }
          if (key.escape) {
            if (customReason) {
              clear();
            } else {
              onKeepPlanning("User cancelled");
            }
            return;
          }
          // Handle text input (arrows, backspace, typing)
          if (handleKey(input, key)) return;
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

    // Generate horizontal lines
    const solidLine = SOLID_LINE.repeat(Math.max(columns - 2, 10));
    const dottedLine = DOTTED_LINE.repeat(Math.max(columns - 2, 10));

    // Memoize the static plan content so it doesn't re-render on keystroke
    // This prevents flicker when typing feedback in the custom input field
    const memoizedPlanContent = useMemo(
      () => (
        <>
          {/* Top solid line */}
          <Text dimColor>{solidLine}</Text>

          {/* Header */}
          <Text bold color={colors.approval.header}>
            Ready to code? Here is your plan:
          </Text>

          {/* Dotted separator before plan content */}
          <Text dimColor>{dottedLine}</Text>

          {/* Plan content - no indentation, just like Claude Code */}
          <MarkdownDisplay text={plan} />

          {/* Dotted separator after plan content */}
          <Text dimColor>{dottedLine}</Text>
        </>
      ),
      [plan, solidLine, dottedLine],
    );

    // Hint text based on state
    const hintText = isOnCustomOption
      ? customReason
        ? "Enter to submit · Esc to clear"
        : "Type feedback · Esc to cancel"
      : "Enter to select · Esc to cancel";

    return (
      <Box flexDirection="column" marginTop={1}>
        {/* Static plan content - memoized to prevent re-render on keystroke */}
        {memoizedPlanContent}

        {/* Question */}
        <Box marginTop={1}>
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

InlinePlanApproval.displayName = "InlinePlanApproval";
