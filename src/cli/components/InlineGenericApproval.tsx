import { Box, useInput } from "ink";
import { memo, useMemo, useState } from "react";
import { fitPreviewLines } from "@/cli/helpers/approval-preview";
import { useProgressIndicator } from "@/cli/hooks/use-progress-indicator";
import {
  useTerminalRows,
  useTerminalWidth,
} from "@/cli/hooks/use-terminal-width";
import { useTextInputCursor } from "@/cli/hooks/use-text-input-cursor";
import { colors } from "./colors";
import { Text } from "./Text";

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
  showPreview?: boolean;
  defaultScope?: "project" | "session";
};

const SOLID_LINE = "─";

const SCRIPT_PREVIEW_MAX_LINES = 40;

// Rows the live area needs besides the argument preview while this dialog is
// shown: rule, header, spacer, options with spacer, hint with spacer, the
// live-item margin above and the collapsed input margin below, plus slack for
// wrapped option text. This fallback never gets AppCoordinator's eager
// preview commit, so the preview must keep the whole dialog on screen.
const APPROVAL_CHROME_ROWS = 14;
const MIN_PREVIEW_ROWS = 3;

/**
 * A `script` argument is source the user is approving to run; show it
 * verbatim (not JSON-escaped and cut mid-line) after the other arguments.
 */
function formatScriptArgs(
  parsed: Record<string, unknown>,
  maxRows: number,
  width: number,
): string {
  const { script, ...rest } = parsed;
  const header =
    Object.keys(rest).length > 0 ? `${JSON.stringify(rest, null, 2)}\n\n` : "";
  const headerLines = header ? header.split("\n").slice(0, -1) : [];
  const lines = [...headerLines, ...String(script).split("\n")];
  return fitPreviewLines(
    lines,
    maxRows,
    width,
    headerLines.length + SCRIPT_PREVIEW_MAX_LINES,
  ).join("\n");
}

function formatArgs(toolArgs: string, maxRows: number, width: number): string {
  try {
    const parsed = JSON.parse(toolArgs);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.script === "string"
    ) {
      return formatScriptArgs(
        parsed as Record<string, unknown>,
        maxRows,
        width,
      );
    }
    let formatted = JSON.stringify(parsed, null, 2);
    if (formatted.length > 500) {
      formatted = `${formatted.slice(0, 500)}\n...`;
    }
    return fitPreviewLines(formatted.split("\n"), maxRows, width).join("\n");
  } catch {
    const raw = toolArgs || "(no arguments)";
    return fitPreviewLines(raw.split("\n"), maxRows, width).join("\n");
  }
}

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
    showPreview = true,
    defaultScope = "project",
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
            onApproveAlways(defaultScope);
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
          onApproveAlways(defaultScope);
          return;
        }
      },
      { isActive: isFocused },
    );

    const solidLine = SOLID_LINE.repeat(Math.max(columns, 10));
    // The preview box is indented by 2 columns.
    const formattedArgs = formatArgs(
      toolArgs,
      Math.max(MIN_PREVIEW_ROWS, terminalRows - APPROVAL_CHROME_ROWS),
      columns - 2,
    );

    // Memoize the static tool content so it doesn't re-render on keystroke
    // This prevents flicker when typing feedback in the custom input field
    const memoizedToolContent = useMemo(
      () => (
        <>
          <Text dimColor>{solidLine}</Text>

          <Text bold color={colors.approval.header}>
            Run {toolName}?
          </Text>

          <Box height={1} />

          <Box paddingLeft={2} flexDirection="column">
            <Text dimColor>{formattedArgs}</Text>
          </Box>
        </>
      ),
      [toolName, formattedArgs, solidLine],
    );

    const hintText = isOnCustomOption
      ? customReason
        ? "Enter to submit · Esc to clear"
        : "Type reason · Esc to cancel"
      : "Enter to select · Esc to cancel";

    const optionsMarginTop = showPreview ? 1 : 0;

    return (
      <Box flexDirection="column">
        {showPreview && memoizedToolContent}

        <Box marginTop={optionsMarginTop} flexDirection="column">
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
                  {approveAlwaysText ||
                    "Yes, and don't ask again for this project"}
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

InlineGenericApproval.displayName = "InlineGenericApproval";
