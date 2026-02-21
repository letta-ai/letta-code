import { Box, useInput } from "ink";
import { memo, useCallback, useState } from "react";
import { generateAndOpenPlanViewer } from "../../web/generate-plan-viewer";
import { useProgressIndicator } from "../hooks/useProgressIndicator";
import { useTerminalWidth } from "../hooks/useTerminalWidth";
import { useTextInputCursor } from "../hooks/useTextInputCursor";
import { colors } from "./colors";
import { Text } from "./Text";

type Props = {
  onApprove: () => void;
  onApproveAndAcceptEdits: () => void;
  onKeepPlanning: (reason: string) => void;
  onCancel: () => void; // For CTRL-C to queue denial (like other approval screens)
  isFocused?: boolean;
  planContent?: string;
  planFilePath?: string;
  agentName?: string;
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
    onCancel,
    isFocused = true,
    planContent,
    planFilePath,
    agentName,
  }: Props) => {
    const [selectedOption, setSelectedOption] = useState(0);
    const [browserStatus, setBrowserStatus] = useState("");
    const {
      text: customReason,
      cursorPos,
      handleKey,
      clear,
    } = useTextInputCursor();
    const columns = useTerminalWidth();
    useProgressIndicator();

    const openInBrowser = useCallback(() => {
      if (!planContent || !planFilePath) return;
      setBrowserStatus("Opening in browser...");
      generateAndOpenPlanViewer(planContent, planFilePath, { agentName })
        .then((result) => {
          setBrowserStatus(
            result.opened
              ? "Opened in browser"
              : `Run: open ${result.filePath}`,
          );
          setTimeout(() => setBrowserStatus(""), 5000);
        })
        .catch(() => {
          setBrowserStatus("Failed to open browser");
          setTimeout(() => setBrowserStatus(""), 5000);
        });
    }, [planContent, planFilePath, agentName]);

    const customOptionIndex = 2;
    const maxOptionIndex = customOptionIndex;
    const isOnCustomOption = selectedOption === customOptionIndex;
    const customOptionPlaceholder =
      "Type here to tell Letta Code what to change";

    useInput(
      (input, key) => {
        if (!isFocused) return;

        // CTRL-C: cancel and queue denial (like other approval screens)
        if (key.ctrl && input === "c") {
          onCancel();
          return;
        }

        // O: open plan in browser (only when not typing in custom field)
        if (
          (input === "o" || input === "O") &&
          !isOnCustomOption &&
          planContent
        ) {
          openInBrowser();
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
          return;
        }

        // Number keys for quick selection (only for fixed options, not custom text input)
        if (input === "1") {
          onApproveAndAcceptEdits();
          return;
        }
        if (input === "2") {
          onApprove();
          return;
        }
      },
      { isActive: isFocused },
    );

    // Hint text based on state
    const browserHint = planContent ? " · O open in browser" : "";
    const hintText = isOnCustomOption
      ? customReason
        ? "Enter to submit · Esc to clear"
        : "Type feedback · Esc to cancel"
      : `Enter to select${browserHint} · Esc to cancel`;

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
          <Text dimColor>{browserStatus || hintText}</Text>
        </Box>
      </Box>
    );
  },
);

StaticPlanApproval.displayName = "StaticPlanApproval";
