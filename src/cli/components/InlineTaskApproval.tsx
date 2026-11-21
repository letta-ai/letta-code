import { Box, useInput } from "ink";
import { memo, useMemo, useState } from "react";
import {
  countPreviewRows,
  fitPreviewLines,
} from "@/cli/helpers/approval-preview";
import { useProgressIndicator } from "@/cli/hooks/use-progress-indicator";
import {
  useTerminalRows,
  useTerminalWidth,
} from "@/cli/hooks/use-terminal-width";
import { useTextInputCursor } from "@/cli/hooks/use-text-input-cursor";
import { colors } from "./colors";
import { Text } from "./Text";

type Props = {
  taskInfo: {
    subagentType: string;
    description: string;
    prompt: string;
    model?: string;
    isBackground?: boolean;
  };
  onApprove: () => void;
  onApproveAlways: (scope: "project" | "session") => void;
  onDeny: (reason: string) => void;
  onCancel?: () => void;
  isFocused?: boolean;
  approveAlwaysText?: string;
  allowPersistence?: boolean;
};

const SOLID_LINE = "─";

// Rows the live area needs besides the summary and prompt while this dialog
// is shown: rule, header, spacers, options with spacer, hint with spacer, the
// live-item margin above and the collapsed input margin below, plus slack for
// wrapped option text. Task approvals never get AppCoordinator's eager
// preview commit, so the prompt must keep the whole dialog on screen.
const APPROVAL_CHROME_ROWS = 15;
const MIN_PROMPT_ROWS = 3;

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
    const terminalRows = useTerminalRows();
    useProgressIndicator();

    const customOptionIndex = allowPersistence ? 2 : 1;
    const maxOptionIndex = customOptionIndex;
    const isOnCustomOption = selectedOption === customOptionIndex;
    const customOptionPlaceholder =
      "No, and tell Letta Code what to do differently";

    useInput(
      (input, key) => {
        if (!isFocused) return;

        if (key.ctrl && input === "c") {
          onCancel?.();
          return;
        }

        if (key.upArrow) {
          setSelectedOption((prev) => Math.max(0, prev - 1));
          return;
        }
        if (key.downArrow) {
          setSelectedOption((prev) => Math.min(maxOptionIndex, prev + 1));
          return;
        }

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
          if (handleKey(input, key)) return;
        }

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
          return;
        }

        if (input === "1") {
          onApprove();
          return;
        }
        if (input === "2" && allowPersistence) {
          onApproveAlways("session");
          return;
        }
      },
      { isActive: isFocused },
    );

    const solidLine = SOLID_LINE.repeat(Math.max(columns, 10));
    const contentWidth = Math.max(0, columns - 4); // 2 padding on each side

    // Memoize the static task content so it doesn't re-render on keystroke
    const memoizedTaskContent = useMemo(() => {
      const { subagentType, description, prompt, model, isBackground } =
        taskInfo;

      // Show as much of the prompt as fits, from the start: a live area
      // taller than the terminal is clipped to its bottom rows, which would
      // hide the header and the task being approved.
      const summary = `${subagentType}${isBackground ? " [background]" : ""} — ${description}${model ? ` (${model})` : ""}`;
      const truncatedPrompt = fitPreviewLines(
        prompt.split("\n"),
        Math.max(
          MIN_PROMPT_ROWS,
          terminalRows -
            APPROVAL_CHROME_ROWS -
            countPreviewRows(summary.split("\n"), contentWidth),
        ),
        contentWidth,
      ).join("\n");

      return (
        <>
          <Text dimColor>{solidLine}</Text>

          <Text bold color={colors.approval.header}>
            Dispatch subagent?
          </Text>

          <Box paddingLeft={2} flexDirection="column" marginTop={1}>
            <Box flexDirection="row">
              <Box flexGrow={1} width={contentWidth}>
                <Text wrap="wrap">
                  <Text bold color={colors.subagent.header}>
                    {subagentType}
                  </Text>
                  {isBackground && <Text dimColor>{" [background]"}</Text>}
                  <Text dimColor>
                    {" — "}
                    {description}
                    {model ? ` (${model})` : ""}
                  </Text>
                </Text>
              </Box>
            </Box>

            <Box marginTop={1}>
              <Box flexGrow={1} width={contentWidth}>
                <Text wrap="wrap" dimColor>
                  {truncatedPrompt}
                </Text>
              </Box>
            </Box>
          </Box>
        </>
      );
    }, [taskInfo, solidLine, contentWidth, terminalRows]);

    const hintText = isOnCustomOption
      ? customReason
        ? "Enter to submit · Esc to clear"
        : "Type reason · Esc to cancel"
      : "Enter to select · Esc to cancel";

    const alwaysText =
      approveAlwaysText || "Yes, allow subagent operations during this session";

    return (
      <Box flexDirection="column">
        {/* Static task content - memoized to prevent re-render on keystroke */}
        {memoizedTaskContent}

        <Box marginTop={1} flexDirection="column">
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

        <Box marginTop={1}>
          <Text dimColor>{hintText}</Text>
        </Box>
      </Box>
    );
  },
);

InlineTaskApproval.displayName = "InlineTaskApproval";
