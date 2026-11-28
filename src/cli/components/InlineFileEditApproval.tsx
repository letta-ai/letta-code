import { Box, useInput } from "ink";
import { memo, useMemo, useState } from "react";
import type { AdvancedDiffSuccess } from "@/cli/helpers/diff";
import { parsePatchToAdvancedDiff } from "@/cli/helpers/diff";
import { parsePatchOperations } from "@/cli/helpers/format-args-display";
import { useProgressIndicator } from "@/cli/hooks/use-progress-indicator";
import { useTerminalWidth } from "@/cli/hooks/use-terminal-width";
import { useTextInputCursor } from "@/cli/hooks/use-text-input-cursor";
import { AdvancedDiffRenderer } from "./AdvancedDiffRenderer";
import { colors } from "./colors";
import { Text } from "./Text";

type FileEditInfo = {
  toolName: string;
  filePath: string;
  content?: string;
  oldString?: string;
  newString?: string;
  replaceAll?: boolean;
  patchInput?: string;
  toolCallId?: string;
};

type Props = {
  fileEdit: FileEditInfo;
  precomputedDiff?: AdvancedDiffSuccess;
  allDiffs?: Map<string, AdvancedDiffSuccess>;
  onApprove: (diffs?: Map<string, AdvancedDiffSuccess>) => void;
  onApproveAlways: (
    scope: "project" | "session",
    diffs?: Map<string, AdvancedDiffSuccess>,
  ) => void;
  onDeny: (reason: string) => void;
  onCancel?: () => void;
  isFocused?: boolean;
  approveAlwaysText?: string;
  allowPersistence?: boolean;
  showPreview?: boolean;
  defaultScope?: "project" | "session";
  sessionPreview?: React.ReactNode;
  workingDirectory?: string;
  headerOverride?: string;
};

const SOLID_LINE = "─";
const DOTTED_LINE = "╌";

function getHeaderText(fileEdit: FileEditInfo, cwd: string): string {
  const t = fileEdit.toolName.toLowerCase();

  if (t === "applypatch") {
    if (fileEdit.patchInput) {
      const operations = parsePatchOperations(fileEdit.patchInput);
      if (operations.length > 1) {
        return `Apply patch to ${operations.length} files?`;
      } else if (operations.length === 1) {
        const op = operations[0];
        if (op) {
          const { relative } = require("node:path");
          const relPath = relative(cwd, op.path);
          const displayPath = relPath.startsWith("..") ? op.path : relPath;

          if (op.kind === "add") {
            return `Write to ${displayPath}?`;
          } else if (op.kind === "update") {
            return `Update ${displayPath}?`;
          } else if (op.kind === "delete") {
            return `Delete ${displayPath}?`;
          }
        }
      }
    }
    return "Apply patch?";
  }

  const { relative } = require("node:path");
  const relPath = relative(cwd, fileEdit.filePath);
  const displayPath = relPath.startsWith("..") ? fileEdit.filePath : relPath;

  if (t === "write") {
    return `Write to ${displayPath}?`;
  }

  if (t === "edit") {
    return `Update ${displayPath}?`;
  }

  return `Edit ${displayPath}?`;
}

function getDiffKind(toolName: string): "write" | "edit" {
  return toolName.toLowerCase() === "write" ? "write" : "edit";
}

export const InlineFileEditApproval = memo(
  ({
    fileEdit,
    precomputedDiff,
    allDiffs,
    onApprove,
    onApproveAlways,
    onDeny,
    onCancel,
    isFocused = true,
    approveAlwaysText,
    allowPersistence = true,
    showPreview = true,
    defaultScope = "project",
    headerOverride,
    sessionPreview,
    workingDirectory,
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

    const diffsToPass = useMemo((): Map<string, AdvancedDiffSuccess> => {
      const diffs = new Map<string, AdvancedDiffSuccess>();
      const toolCallId = fileEdit.toolCallId;

      if (precomputedDiff && toolCallId) {
        diffs.set(toolCallId, precomputedDiff);
        return diffs;
      }

      if (fileEdit.patchInput && toolCallId) {
        if (allDiffs) {
          const operations = parsePatchOperations(fileEdit.patchInput);
          for (const op of operations) {
            const key = `${toolCallId}:${op.path}`;
            const diff = allDiffs.get(key);
            if (diff) {
              diffs.set(key, diff);
            }
          }
        }

        if (diffs.size === 0) {
          const operations = parsePatchOperations(fileEdit.patchInput);
          for (const op of operations) {
            const key = `${toolCallId}:${op.path}`;
            if (op.kind === "add" || op.kind === "update") {
              const result = parsePatchToAdvancedDiff(op.patchLines, op.path);
              if (result) {
                diffs.set(key, result);
              }
            }
          }
        }
      }

      return diffs;
    }, [fileEdit, precomputedDiff, allDiffs]);

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
            onApprove(diffsToPass.size > 0 ? diffsToPass : undefined);
          } else if (selectedOption === 1 && allowPersistence) {
            onApproveAlways(
              defaultScope,
              diffsToPass.size > 0 ? diffsToPass : undefined,
            );
          }
          return;
        }
        if (key.escape) {
          onCancel?.();
          return;
        }

        if (input === "1") {
          onApprove(diffsToPass.size > 0 ? diffsToPass : undefined);
          return;
        }
        if (input === "2" && allowPersistence) {
          onApproveAlways(
            defaultScope,
            diffsToPass.size > 0 ? diffsToPass : undefined,
          );
          return;
        }
      },
      { isActive: isFocused },
    );

    const solidLine = SOLID_LINE.repeat(Math.max(columns, 10));
    const dottedLine = DOTTED_LINE.repeat(Math.max(columns, 10));
    const headerText =
      headerOverride ||
      getHeaderText(fileEdit, workingDirectory ?? process.cwd());
    const diffKind = getDiffKind(fileEdit.toolName);

    const memoizedDiffContent = useMemo(
      () => (
        <>
          <Text dimColor>{solidLine}</Text>

          <Text bold color={colors.approval.header}>
            {headerText}
          </Text>

          <Text dimColor>{dottedLine}</Text>

          <Box paddingLeft={0}>
            {sessionPreview ??
              (fileEdit.patchInput ? (
                <Box flexDirection="column">
                  {parsePatchOperations(fileEdit.patchInput).map((op, idx) => {
                    const { relative } = require("node:path");
                    const cwd = process.cwd();
                    const relPath = relative(cwd, op.path);
                    const displayPath = relPath.startsWith("..")
                      ? op.path
                      : relPath;

                    const diffKey = fileEdit.toolCallId
                      ? `${fileEdit.toolCallId}:${op.path}`
                      : undefined;
                    const opDiff =
                      diffKey && allDiffs ? allDiffs.get(diffKey) : undefined;

                    if (op.kind === "add") {
                      return (
                        <Box
                          key={`patch-add-${op.path}`}
                          flexDirection="column"
                        >
                          {idx > 0 && <Box height={1} />}
                          <Text dimColor>{displayPath}</Text>
                          <AdvancedDiffRenderer
                            precomputed={opDiff}
                            kind="write"
                            filePath={op.path}
                            content={op.content}
                            showHeader={false}
                          />
                        </Box>
                      );
                    } else if (op.kind === "update") {
                      return (
                        <Box
                          key={`patch-update-${op.path}`}
                          flexDirection="column"
                        >
                          {idx > 0 && <Box height={1} />}
                          <Text dimColor>{displayPath}</Text>
                          <AdvancedDiffRenderer
                            precomputed={opDiff}
                            kind="edit"
                            filePath={op.path}
                            oldString={op.oldString}
                            newString={op.newString}
                            showHeader={false}
                          />
                        </Box>
                      );
                    } else if (op.kind === "delete") {
                      return (
                        <Box
                          key={`patch-delete-${op.path}`}
                          flexDirection="column"
                        >
                          {idx > 0 && <Box height={1} />}
                          <Text dimColor>{displayPath}</Text>
                          <Text color="red">File will be deleted</Text>
                        </Box>
                      );
                    }
                    return null;
                  })}
                </Box>
              ) : diffKind === "write" ? (
                <AdvancedDiffRenderer
                  precomputed={precomputedDiff}
                  kind="write"
                  filePath={fileEdit.filePath}
                  content={fileEdit.content || ""}
                  showHeader={false}
                />
              ) : (
                <AdvancedDiffRenderer
                  precomputed={precomputedDiff}
                  kind="edit"
                  filePath={fileEdit.filePath}
                  oldString={fileEdit.oldString || ""}
                  newString={fileEdit.newString || ""}
                  replaceAll={fileEdit.replaceAll}
                  showHeader={false}
                />
              ))}
          </Box>

          <Text dimColor>{dottedLine}</Text>
        </>
      ),
      [
        fileEdit.filePath,
        fileEdit.content,
        fileEdit.oldString,
        fileEdit.newString,
        fileEdit.replaceAll,
        fileEdit.patchInput,
        fileEdit.toolCallId,
        precomputedDiff,
        allDiffs,
        solidLine,
        dottedLine,
        headerText,
        sessionPreview,
        diffKind,
      ],
    );

    const hintText = isOnCustomOption
      ? customReason
        ? "Enter to submit · Esc to clear"
        : "Type reason · Esc to cancel"
      : "Enter to select · Esc to cancel";

    const optionsMarginTop = showPreview ? 1 : 0;

    return (
      <Box flexDirection="column">
        {showPreview && memoizedDiffContent}

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

InlineFileEditApproval.displayName = "InlineFileEditApproval";
