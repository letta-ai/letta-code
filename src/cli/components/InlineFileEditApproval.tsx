import { Box, Text, useInput } from "ink";
import { memo, useMemo, useState } from "react";
import type { AdvancedDiffSuccess } from "../helpers/diff";
import { parsePatchToAdvancedDiff } from "../helpers/diff";
import { parsePatchOperations } from "../helpers/formatArgsDisplay";
import { useTerminalWidth } from "../hooks/useTerminalWidth";
import { AdvancedDiffRenderer } from "./AdvancedDiffRenderer";
import { colors } from "./colors";

type FileEditInfo = {
  toolName: string;
  filePath: string;
  // For write tools
  content?: string;
  // For edit tools
  oldString?: string;
  newString?: string;
  replaceAll?: boolean;
  // For multi_edit tools
  edits?: Array<{
    old_string: string;
    new_string: string;
    replace_all?: boolean;
  }>;
  // For patch tools
  patchInput?: string;
  toolCallId?: string;
};

type Props = {
  fileEdit: FileEditInfo;
  precomputedDiff?: AdvancedDiffSuccess;
  allDiffs?: Map<string, AdvancedDiffSuccess>; // For patch tools with multiple files
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
};

// Horizontal line characters for Claude Code style
const SOLID_LINE = "─";
const DOTTED_LINE = "╌";

/**
 * Get a human-readable header for the file edit
 */
function getHeaderText(fileEdit: FileEditInfo): string {
  const t = fileEdit.toolName.toLowerCase();

  // Handle patch tools (multi-file)
  if (t === "apply_patch" || t === "applypatch") {
    if (fileEdit.patchInput) {
      const operations = parsePatchOperations(fileEdit.patchInput);
      if (operations.length > 1) {
        return `Apply patch to ${operations.length} files?`;
      } else if (operations.length === 1) {
        const op = operations[0];
        if (op) {
          const { relative } = require("node:path");
          const cwd = process.cwd();
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

  // Handle single-file edit/write tools
  const { relative } = require("node:path");
  const cwd = process.cwd();
  const relPath = relative(cwd, fileEdit.filePath);
  const displayPath = relPath.startsWith("..") ? fileEdit.filePath : relPath;

  if (
    t === "write" ||
    t === "write_file" ||
    t === "writefile" ||
    t === "write_file_gemini" ||
    t === "writefilegemini"
  ) {
    const { existsSync } = require("node:fs");
    try {
      if (existsSync(fileEdit.filePath)) {
        return `Overwrite ${displayPath}?`;
      }
    } catch {
      // Ignore errors
    }
    return `Write to ${displayPath}?`;
  }

  if (t === "edit" || t === "replace") {
    return `Update ${displayPath}?`;
  }

  if (t === "multiedit" || t === "multi_edit") {
    return `Update ${displayPath}? (${fileEdit.edits?.length || 0} edits)`;
  }

  return `Edit ${displayPath}?`;
}

/**
 * Determine diff kind based on tool name
 */
function getDiffKind(toolName: string): "write" | "edit" | "multi_edit" {
  const t = toolName.toLowerCase();
  if (
    t === "write" ||
    t === "write_file" ||
    t === "writefile" ||
    t === "write_file_gemini" ||
    t === "writefilegemini"
  ) {
    return "write";
  }
  if (t === "multiedit" || t === "multi_edit") {
    return "multi_edit";
  }
  return "edit";
}

/**
 * InlineFileEditApproval - Renders file edit approval UI inline (Claude Code style)
 *
 * Uses horizontal lines instead of boxes for visual styling:
 * - ──── solid line at top
 * - ╌╌╌╌ dotted line around diff content
 * - Approval options below
 */
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
  }: Props) => {
    const [selectedOption, setSelectedOption] = useState(0);
    const [customReason, setCustomReason] = useState("");
    const columns = useTerminalWidth();

    // Custom option index depends on whether "always" option is shown
    const customOptionIndex = allowPersistence ? 2 : 1;
    const maxOptionIndex = customOptionIndex;
    const isOnCustomOption = selectedOption === customOptionIndex;

    // Build diffs map to pass to approval handler (needed for line numbers in result)
    const diffsToPass = useMemo((): Map<string, AdvancedDiffSuccess> => {
      const diffs = new Map<string, AdvancedDiffSuccess>();
      const toolCallId = fileEdit.toolCallId;

      // For Edit/Write/MultiEdit - single file diff
      if (precomputedDiff && toolCallId) {
        diffs.set(toolCallId, precomputedDiff);
        return diffs;
      }

      // For Patch tools - use allDiffs or parse patch input
      if (fileEdit.patchInput && toolCallId) {
        // First try to use allDiffs if available
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

        // If no diffs found from allDiffs, parse patch hunks directly
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
              onDeny(customReason.trim());
            }
            return;
          }
          if (key.escape) {
            if (customReason) {
              setCustomReason("");
            } else {
              onCancel?.();
            }
            return;
          }
          if (key.backspace || key.delete) {
            setCustomReason((prev) => prev.slice(0, -1));
            return;
          }
          if (input && !key.ctrl && !key.meta && input.length === 1) {
            setCustomReason((prev) => prev + input);
          }
          return;
        }

        // When on regular options
        if (key.return) {
          if (selectedOption === 0) {
            onApprove(diffsToPass.size > 0 ? diffsToPass : undefined);
          } else if (selectedOption === 1 && allowPersistence) {
            onApproveAlways(
              "project",
              diffsToPass.size > 0 ? diffsToPass : undefined,
            );
          }
          return;
        }
        if (key.escape) {
          onCancel?.();
        }
      },
      { isActive: isFocused },
    );

    // Generate horizontal lines
    const solidLine = SOLID_LINE.repeat(Math.max(columns - 2, 10));
    const dottedLine = DOTTED_LINE.repeat(Math.max(columns - 2, 10));
    const headerText = getHeaderText(fileEdit);
    const diffKind = getDiffKind(fileEdit.toolName);

    // Memoize the static diff content so it doesn't re-render on keystroke
    // This prevents flicker when typing feedback in the custom input field
    const memoizedDiffContent = useMemo(
      () => (
        <>
          {/* Top solid line */}
          <Text dimColor>{solidLine}</Text>

          {/* Header */}
          <Text bold color={colors.approval.header}>
            {headerText}
          </Text>

          {/* Dotted separator before diff content */}
          <Text dimColor>{dottedLine}</Text>

          {/* Diff preview */}
          <Box paddingLeft={0}>
            {fileEdit.patchInput ? (
              // Render patch operations (can be multiple files)
              <Box flexDirection="column">
                {parsePatchOperations(fileEdit.patchInput).map((op, idx) => {
                  const { relative } = require("node:path");
                  const cwd = process.cwd();
                  const relPath = relative(cwd, op.path);
                  const displayPath = relPath.startsWith("..")
                    ? op.path
                    : relPath;

                  // Look up precomputed diff using toolCallId:path key
                  const diffKey = fileEdit.toolCallId
                    ? `${fileEdit.toolCallId}:${op.path}`
                    : undefined;
                  const opDiff =
                    diffKey && allDiffs ? allDiffs.get(diffKey) : undefined;

                  if (op.kind === "add") {
                    return (
                      <Box key={`patch-add-${op.path}`} flexDirection="column">
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
            ) : diffKind === "multi_edit" ? (
              <AdvancedDiffRenderer
                precomputed={precomputedDiff}
                kind="multi_edit"
                filePath={fileEdit.filePath}
                edits={fileEdit.edits || []}
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
            )}
          </Box>

          {/* Dotted separator after diff content */}
          <Text dimColor>{dottedLine}</Text>
        </>
      ),
      [
        fileEdit,
        precomputedDiff,
        allDiffs,
        solidLine,
        dottedLine,
        headerText,
        diffKind,
      ],
    );

    // Hint text based on state
    const hintText = isOnCustomOption
      ? customReason
        ? "Enter to submit · Esc to clear"
        : "Type reason · Esc to cancel"
      : "Enter to select · Esc to cancel";

    return (
      <Box flexDirection="column">
        {/* Static diff content - memoized to prevent re-render on keystroke */}
        {memoizedDiffContent}

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

InlineFileEditApproval.displayName = "InlineFileEditApproval";
