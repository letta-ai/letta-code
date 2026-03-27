import { Box, useInput } from "ink";
import { memo, useMemo, useState } from "react";
import { useProgressIndicator } from "../hooks/useProgressIndicator";
import { useTerminalWidth } from "../hooks/useTerminalWidth";
import { useTextInputCursor } from "../hooks/useTextInputCursor";
import { colors } from "./colors";
import { Text } from "./Text";

export type MemoryInfo = {
  command: string;
  reason?: string;
  path?: string;
  oldPath?: string;
  newPath?: string;
  oldString?: string;
  newString?: string;
  insertLine?: number;
  insertText?: string;
  description?: string;
  fileText?: string;
  /** Unified diff input for memory_apply_patch */
  patchInput?: string;
};

type Props = {
  memoryInfo: MemoryInfo;
  onApprove: () => void;
  onApproveAlways: (scope: "project" | "session") => void;
  onDeny: (reason: string) => void;
  onCancel?: () => void;
  isFocused?: boolean;
  approveAlwaysText?: string;
  allowPersistence?: boolean;
  defaultScope?: "project" | "session";
  showPreview?: boolean;
};

const SOLID_LINE = "─";

function getHeader(command: string): string {
  switch (command) {
    case "delete":
      return "Delete memory?";
    case "str_replace":
      return "Edit memory?";
    case "insert":
      return "Insert into memory?";
    case "rename":
      return "Rename memory?";
    case "create":
      return "Create memory?";
    case "update_description":
      return "Update memory description?";
    case "patch":
      return "Patch memory?";
    default:
      return `Run memory ${command}?`;
  }
}

/** Strip .md extension from memory paths for display */
function displayPath(path: string): string {
  return path.replace(/\.md$/, "");
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

/**
 * InlineMemoryApproval - Renders memory tool approval UI inline
 *
 * Shows the memory operation, target path, and key details in a readable format
 * instead of dumping raw JSON.
 */
export const InlineMemoryApproval = memo(
  ({
    memoryInfo,
    onApprove,
    onApproveAlways,
    onDeny,
    onCancel,
    isFocused = true,
    approveAlwaysText,
    allowPersistence = true,
    defaultScope = "project",
    showPreview = true,
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
    const contentWidth = Math.max(0, columns - 4);

    const memoizedContent = useMemo(() => {
      const {
        command,
        reason,
        path,
        oldPath,
        newPath,
        oldString,
        newString,
        insertLine,
        insertText,
        description,
        fileText,
        patchInput,
      } = memoryInfo;

      return (
        <>
          <Text dimColor>{solidLine}</Text>

          <Text bold color={colors.approval.header}>
            {getHeader(command)}
          </Text>

          <Box paddingLeft={2} flexDirection="column" marginTop={1}>
            {/* Path */}
            {command === "rename" ? (
              <Box flexGrow={1} width={contentWidth}>
                <Text wrap="wrap">
                  <Text bold>{displayPath(oldPath || "(unknown)")}</Text>
                  <Text dimColor>{" → "}</Text>
                  <Text bold>{displayPath(newPath || "(unknown)")}</Text>
                </Text>
              </Box>
            ) : (
              path && <Text bold>{displayPath(path)}</Text>
            )}

            {/* Operation-specific details */}
            {command === "str_replace" &&
              oldString != null &&
              newString != null && (
                <Box flexDirection="column" marginTop={1}>
                  <Box flexGrow={1} width={contentWidth}>
                    <Text wrap="wrap">
                      <Text color="red">- {truncate(oldString, 200)}</Text>
                    </Text>
                  </Box>
                  <Box flexGrow={1} width={contentWidth}>
                    <Text wrap="wrap">
                      <Text color="green">+ {truncate(newString, 200)}</Text>
                    </Text>
                  </Box>
                </Box>
              )}

            {command === "insert" && insertText != null && (
              <Box marginTop={1} flexGrow={1} width={contentWidth}>
                <Text wrap="wrap" dimColor>
                  {insertLine != null ? `Line ${insertLine}: ` : ""}
                  {truncate(insertText, 300)}
                </Text>
              </Box>
            )}

            {command === "create" && description && (
              <Box marginTop={1} flexGrow={1} width={contentWidth}>
                <Text wrap="wrap" dimColor>
                  {description}
                </Text>
              </Box>
            )}

            {command === "create" && fileText && (
              <Box marginTop={1} flexGrow={1} width={contentWidth}>
                <Text wrap="wrap" dimColor>
                  {truncate(fileText, 300)}
                </Text>
              </Box>
            )}

            {command === "update_description" && description && (
              <Box marginTop={1} flexGrow={1} width={contentWidth}>
                <Text wrap="wrap" dimColor>
                  {description}
                </Text>
              </Box>
            )}

            {command === "patch" && patchInput && (
              <Box flexDirection="column" marginTop={1}>
                <Box flexGrow={1} width={contentWidth}>
                  <Text wrap="wrap" dimColor>
                    {truncate(patchInput, 500)}
                  </Text>
                </Box>
              </Box>
            )}

            {/* Reason */}
            {reason && (
              <Box marginTop={1} flexGrow={1} width={contentWidth}>
                <Text wrap="wrap" dimColor>
                  {reason}
                </Text>
              </Box>
            )}
          </Box>
        </>
      );
    }, [memoryInfo, solidLine, contentWidth]);

    const hintText = isOnCustomOption
      ? customReason
        ? "Enter to submit · Esc to clear"
        : "Type reason · Esc to cancel"
      : "Enter to select · Esc to cancel";

    const alwaysText =
      approveAlwaysText || "Yes, allow memory operations during this session";

    return (
      <Box flexDirection="column">
        {showPreview && memoizedContent}

        <Box marginTop={showPreview ? 1 : 0} flexDirection="column">
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

          {/* Option 2: Yes, always */}
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

InlineMemoryApproval.displayName = "InlineMemoryApproval";
