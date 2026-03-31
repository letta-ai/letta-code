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
  onConsumeDraft?: () => void;
  showAcceptEditsOption?: boolean;
  isFocused?: boolean;
  planContent?: string;
  planFilePath?: string;
  agentName?: string;
  initialDraft?: string; // Draft text from input buffer when approval appeared
};

/**
 * StaticPlanApproval - Options-only plan approval component
 *
 * This component renders ONLY the approval options (no plan preview).
 * The plan preview is committed separately to the Static area via the
 * eager commit pattern, which keeps this component small and flicker-free.
 */
export const StaticPlanApproval = memo(
  ({
    onApprove,
    onApproveAndAcceptEdits,
    onKeepPlanning,
    onCancel,
    onConsumeDraft,
    showAcceptEditsOption = true,
    isFocused = true,
    planContent,
    planFilePath,
    agentName,
    initialDraft,
  }: Props) => {
    const hasDraft = Boolean(initialDraft && initialDraft.trim().length > 0);

    // Base fixed options are:
    // 1) Yes + auto-accept (or Yes in yolo mode)
    // 2) Yes + manual approve (only when showAcceptEditsOption)
    const fixedOptionCount = showAcceptEditsOption ? 2 : 1;

    // If draft exists, show TWO text options:
    // - pre-populated with current draft
    // - empty freeform input
    const draftOptionIndex = hasDraft ? fixedOptionCount : -1;
    const customOptionIndex = hasDraft
      ? fixedOptionCount + 1
      : fixedOptionCount;
    const maxOptionIndex = customOptionIndex;

    const defaultOptionIndex = hasDraft ? draftOptionIndex : 0;
    const [selectedOption, setSelectedOption] = useState(defaultOptionIndex);
    const [browserStatus, setBrowserStatus] = useState("");

    const draftInput = useTextInputCursor(hasDraft ? initialDraft : "");
    const newInput = useTextInputCursor("");

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

    const effectiveSelectedOption = Math.min(selectedOption, maxOptionIndex);
    const isOnDraftOption =
      hasDraft && effectiveSelectedOption === draftOptionIndex;
    const isOnCustomOption = effectiveSelectedOption === customOptionIndex;
    const isOnTextOption = isOnDraftOption || isOnCustomOption;

    const activeInput = isOnDraftOption
      ? draftInput
      : isOnCustomOption
        ? newInput
        : null;

    useInput(
      (input, key) => {
        if (!isFocused) return;

        // CTRL-C: cancel and queue denial (like other approval screens)
        if (key.ctrl && input === "c") {
          onCancel();
          return;
        }

        // O: open plan in browser (only when not typing in text field)
        if (
          (input === "o" || input === "O") &&
          !isOnTextOption &&
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

        // Text options: pre-populated draft input or empty new input
        if (activeInput) {
          if (key.return) {
            if (activeInput.text.trim()) {
              if (isOnDraftOption) {
                onConsumeDraft?.();
              }
              onKeepPlanning(activeInput.text.trim());
            }
            return;
          }
          if (key.escape) {
            if (activeInput.text) {
              activeInput.clear();
            } else {
              onKeepPlanning("User cancelled");
            }
            return;
          }
          if (activeInput.handleKey(input, key)) return;
        }

        // Regular fixed options
        if (key.return) {
          if (showAcceptEditsOption && effectiveSelectedOption === 0) {
            onApproveAndAcceptEdits();
          } else {
            onApprove();
          }
          return;
        }
        if (key.escape) {
          onKeepPlanning("User cancelled");
          return;
        }

        // Number keys for quick selection
        if (input === "1") {
          if (showAcceptEditsOption) {
            onApproveAndAcceptEdits();
          } else {
            onApprove();
          }
          return;
        }
        if (showAcceptEditsOption && input === "2") {
          onApprove();
          return;
        }

        if (hasDraft && input === String(draftOptionIndex + 1)) {
          setSelectedOption(draftOptionIndex);
          return;
        }
        if (input === String(customOptionIndex + 1)) {
          setSelectedOption(customOptionIndex);
        }
      },
      { isActive: isFocused },
    );

    const browserHint = planContent ? " · O open in browser" : "";
    const activeText = activeInput?.text || "";
    const hintText = isOnTextOption
      ? activeText
        ? "Enter to submit · Esc to clear"
        : "Type feedback · Esc to cancel"
      : `Enter to select${browserHint} · Esc to cancel`;

    const textOptionColor = colors.approval.header;

    return (
      <Box flexDirection="column">
        <Box>
          <Text>Would you like to proceed?</Text>
        </Box>

        <Box marginTop={1} flexDirection="column">
          {/* Option 1 */}
          <Box flexDirection="row">
            <Box width={5} flexShrink={0}>
              <Text
                color={
                  effectiveSelectedOption === 0
                    ? colors.approval.header
                    : undefined
                }
              >
                {effectiveSelectedOption === 0 ? "❯" : " "} 1.
              </Text>
            </Box>
            <Box flexGrow={1} width={Math.max(0, columns - 5)}>
              <Text
                wrap="wrap"
                color={
                  effectiveSelectedOption === 0
                    ? colors.approval.header
                    : undefined
                }
              >
                {showAcceptEditsOption
                  ? "Yes, and auto-accept edits"
                  : "Yes, proceed (bypassPermissions / yolo mode)"}
              </Text>
            </Box>
          </Box>

          {/* Option 2 */}
          {showAcceptEditsOption && (
            <Box flexDirection="row">
              <Box width={5} flexShrink={0}>
                <Text
                  color={
                    effectiveSelectedOption === 1
                      ? colors.approval.header
                      : undefined
                  }
                >
                  {effectiveSelectedOption === 1 ? "❯" : " "} 2.
                </Text>
              </Box>
              <Box flexGrow={1} width={Math.max(0, columns - 5)}>
                <Text
                  wrap="wrap"
                  color={
                    effectiveSelectedOption === 1
                      ? colors.approval.header
                      : undefined
                  }
                >
                  Yes, and manually approve edits
                </Text>
              </Box>
            </Box>
          )}

          {/* Option N: Pre-populated draft input */}
          {hasDraft && (
            <Box flexDirection="row">
              <Box width={5} flexShrink={0}>
                <Text color={isOnDraftOption ? textOptionColor : undefined}>
                  {isOnDraftOption ? "❯" : " "} {draftOptionIndex + 1}.
                </Text>
              </Box>
              <Box flexGrow={1} width={Math.max(0, columns - 5)}>
                {isOnDraftOption ? (
                  <Text wrap="wrap">
                    {draftInput.text.slice(0, draftInput.cursorPos)}█
                    {draftInput.text.slice(draftInput.cursorPos)}
                  </Text>
                ) : (
                  <Text wrap="wrap" dimColor>
                    {draftInput.text}
                  </Text>
                )}
              </Box>
            </Box>
          )}

          {/* Last option: Empty freeform input */}
          <Box flexDirection="row">
            <Box width={5} flexShrink={0}>
              <Text color={isOnCustomOption ? textOptionColor : undefined}>
                {isOnCustomOption ? "❯" : " "} {customOptionIndex + 1}.
              </Text>
            </Box>
            <Box flexGrow={1} width={Math.max(0, columns - 5)}>
              {isOnCustomOption ? (
                <Text wrap="wrap">
                  {newInput.text.slice(0, newInput.cursorPos)}█
                  {newInput.text.slice(newInput.cursorPos)}
                </Text>
              ) : (
                <Text wrap="wrap" dimColor>
                  {newInput.text}
                </Text>
              )}
            </Box>
          </Box>
        </Box>

        <Box marginTop={1}>
          <Text dimColor>{browserStatus || hintText}</Text>
        </Box>
      </Box>
    );
  },
);

StaticPlanApproval.displayName = "StaticPlanApproval";
