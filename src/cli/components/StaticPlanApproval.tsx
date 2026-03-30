import { Box, useInput } from "ink";
import { memo, useCallback, useEffect, useRef, useState } from "react";
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
    // - Edit current draft (default)
    // - Type new message. (empty)
    const draftOptionIndex = hasDraft ? fixedOptionCount : -1;
    const customOptionIndex = hasDraft
      ? fixedOptionCount + 1
      : fixedOptionCount;
    const maxOptionIndex = customOptionIndex;

    const defaultOptionIndex = hasDraft ? draftOptionIndex : 0;
    const [selectedOption, setSelectedOption] = useState(defaultOptionIndex);
    const [browserStatus, setBrowserStatus] = useState("");

    const {
      text: customReason,
      setText: setCustomReason,
      cursorPos,
      setCursorPos,
      handleKey,
      clear,
    } = useTextInputCursor(hasDraft ? initialDraft : "");

    const previousSelectedOptionRef = useRef(defaultOptionIndex);

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

    // Moving from draft-edit to empty custom should clear local text while
    // preserving the upstream main-input draft buffer.
    useEffect(() => {
      const previous = previousSelectedOptionRef.current;
      if (
        hasDraft &&
        previous === draftOptionIndex &&
        effectiveSelectedOption === customOptionIndex
      ) {
        clear();
      }
      previousSelectedOptionRef.current = effectiveSelectedOption;
    }, [
      hasDraft,
      draftOptionIndex,
      customOptionIndex,
      effectiveSelectedOption,
      clear,
    ]);

    // If user re-selects draft option after clearing, restore initial draft text.
    useEffect(() => {
      if (isOnDraftOption && !customReason && initialDraft) {
        setCustomReason(initialDraft);
        setCursorPos(initialDraft.length);
      }
    }, [
      isOnDraftOption,
      customReason,
      initialDraft,
      setCustomReason,
      setCursorPos,
    ]);

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

        // Text options: draft edit or empty new message
        if (isOnTextOption) {
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
          if (handleKey(input, key)) return;
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
    const hintText = isOnTextOption
      ? customReason
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

          {/* Option N: Edit current draft */}
          {hasDraft && (
            <Box flexDirection="row">
              <Box width={5} flexShrink={0}>
                <Text color={isOnDraftOption ? textOptionColor : undefined}>
                  {isOnDraftOption ? "❯" : " "} {draftOptionIndex + 1}.
                </Text>
              </Box>
              <Box flexGrow={1} width={Math.max(0, columns - 5)}>
                {isOnDraftOption && customReason ? (
                  <Text wrap="wrap">
                    {customReason.slice(0, cursorPos)}█
                    {customReason.slice(cursorPos)}
                  </Text>
                ) : (
                  <Text wrap="wrap" dimColor>
                    Edit current draft
                  </Text>
                )}
              </Box>
            </Box>
          )}

          {/* Last option: Empty input */}
          <Box flexDirection="row">
            <Box width={5} flexShrink={0}>
              <Text color={isOnCustomOption ? textOptionColor : undefined}>
                {isOnCustomOption ? "❯" : " "} {customOptionIndex + 1}.
              </Text>
            </Box>
            <Box flexGrow={1} width={Math.max(0, columns - 5)}>
              {isOnCustomOption && customReason ? (
                <Text wrap="wrap">
                  {customReason.slice(0, cursorPos)}█
                  {customReason.slice(cursorPos)}
                </Text>
              ) : (
                <Text wrap="wrap" dimColor>
                  {hasDraft
                    ? "Type new message."
                    : "Type here to tell Letta Code what to change"}
                  {isOnCustomOption && "█"}
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
