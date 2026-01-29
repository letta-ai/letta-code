import { Box, Text } from "ink";
import { memo } from "react";
import type { AdvancedDiffSuccess } from "../helpers/diff";
import { parsePatchOperations } from "../helpers/formatArgsDisplay";
import { useTerminalWidth } from "../hooks/useTerminalWidth";
import { AdvancedDiffRenderer } from "./AdvancedDiffRenderer";
import { colors } from "./colors";
import { BashPreview } from "./previews/BashPreview";
import { PlanPreview } from "./previews/PlanPreview";

const SOLID_LINE = "─";
const DOTTED_LINE = "╌";

type Props = {
  toolName: string;
  toolArgs: string;
  precomputedDiff?: AdvancedDiffSuccess;
  allDiffs?: Map<string, AdvancedDiffSuccess>;
  planContent?: string;
  planFilePath?: string;
  toolCallId?: string;
};

/**
 * Get a human-readable header for file edit tools
 */
function getFileEditHeader(toolName: string, toolArgs: string): string {
  const t = toolName.toLowerCase();

  try {
    const args = JSON.parse(toolArgs);

    // Handle patch tools
    if (t === "apply_patch" || t === "applypatch") {
      if (args.input) {
        const operations = parsePatchOperations(args.input);
        if (operations.length > 1) {
          return `Apply patch to ${operations.length} files?`;
        } else if (operations.length === 1) {
          const op = operations[0];
          if (op) {
            const { relative } = require("node:path");
            const cwd = process.cwd();
            const relPath = relative(cwd, op.path);
            const displayPath = relPath.startsWith("..") ? op.path : relPath;

            if (op.kind === "add") return `Write to ${displayPath}?`;
            if (op.kind === "update") return `Update ${displayPath}?`;
            if (op.kind === "delete") return `Delete ${displayPath}?`;
          }
        }
      }
      return "Apply patch?";
    }

    // Handle single-file edit/write tools
    const filePath = args.file_path || "";
    const { relative } = require("node:path");
    const cwd = process.cwd();
    const relPath = relative(cwd, filePath);
    const displayPath = relPath.startsWith("..") ? filePath : relPath;

    if (
      t === "write" ||
      t === "write_file" ||
      t === "writefile" ||
      t === "write_file_gemini" ||
      t === "writefilegemini"
    ) {
      const { existsSync } = require("node:fs");
      try {
        if (existsSync(filePath)) {
          return `Overwrite ${displayPath}?`;
        }
      } catch {
        // Ignore
      }
      return `Write to ${displayPath}?`;
    }

    if (
      t === "edit" ||
      t === "str_replace_editor" ||
      t === "str_replace_based_edit_tool"
    ) {
      return `Update ${displayPath}?`;
    }

    if (t === "multi_edit" || t === "multiedit") {
      return `Apply edits to ${displayPath}?`;
    }
  } catch {
    // Fall through
  }

  return `${toolName} requires approval`;
}

/**
 * ApprovalPreview - Renders the preview content for an eagerly-committed approval
 *
 * This component renders the "preview" part of an approval that was committed
 * early to enable flicker-free approval UI. It ensures visual parity with
 * what the inline approval components show.
 */
export const ApprovalPreview = memo(
  ({
    toolName,
    toolArgs,
    precomputedDiff,
    allDiffs,
    planContent,
    toolCallId,
  }: Props) => {
    const columns = useTerminalWidth();
    const solidLine = SOLID_LINE.repeat(Math.max(columns, 10));
    const dottedLine = DOTTED_LINE.repeat(Math.max(columns, 10));

    // ExitPlanMode: Use PlanPreview component
    if (toolName === "ExitPlanMode" && planContent) {
      return (
        <Box flexDirection="column">
          <PlanPreview plan={planContent} />
        </Box>
      );
    }

    // Bash/Shell: Use BashPreview component
    if (
      toolName === "Bash" ||
      toolName === "shell" ||
      toolName === "Shell" ||
      toolName === "shell_command"
    ) {
      try {
        const args = JSON.parse(toolArgs);
        const command =
          typeof args.command === "string"
            ? args.command
            : Array.isArray(args.command)
              ? args.command.join(" ")
              : "";
        const description = args.description || args.justification || "";

        return (
          <Box flexDirection="column">
            <BashPreview command={command} description={description} />
          </Box>
        );
      } catch {
        // Fall through to generic
      }
    }

    // File Edit tools: Render diff preview
    if (
      toolName === "Edit" ||
      toolName === "MultiEdit" ||
      toolName === "Write" ||
      toolName === "str_replace_editor" ||
      toolName === "str_replace_based_edit_tool" ||
      toolName === "apply_patch" ||
      toolName === "ApplyPatch"
    ) {
      const headerText = getFileEditHeader(toolName, toolArgs);

      try {
        const args = JSON.parse(toolArgs);

        // Handle patch tools (can have multiple files)
        if (
          args.input &&
          (toolName === "apply_patch" || toolName === "ApplyPatch")
        ) {
          const operations = parsePatchOperations(args.input);

          return (
            <Box flexDirection="column">
              <Text dimColor>{solidLine}</Text>
              <Text bold color={colors.approval.header}>
                {headerText}
              </Text>
              <Text dimColor>{dottedLine}</Text>

              <Box flexDirection="column">
                {operations.map((op, idx) => {
                  const { relative } = require("node:path");
                  const cwd = process.cwd();
                  const relPath = relative(cwd, op.path);
                  const displayPath = relPath.startsWith("..")
                    ? op.path
                    : relPath;

                  const diffKey = toolCallId
                    ? `${toolCallId}:${op.path}`
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
                  }
                  if (op.kind === "update") {
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
                  }
                  if (op.kind === "delete") {
                    return (
                      <Box key={`patch-delete-${op.path}`}>
                        {idx > 0 && <Box height={1} />}
                        <Text>
                          Delete <Text bold>{displayPath}</Text>
                        </Text>
                      </Box>
                    );
                  }
                  return null;
                })}
              </Box>

              <Text dimColor>{dottedLine}</Text>
            </Box>
          );
        }

        // Single file edit/write
        const filePath = args.file_path || "";

        return (
          <Box flexDirection="column">
            <Text dimColor>{solidLine}</Text>
            <Text bold color={colors.approval.header}>
              {headerText}
            </Text>
            <Text dimColor>{dottedLine}</Text>

            {/* Write */}
            {args.content !== undefined && (
              <AdvancedDiffRenderer
                precomputed={precomputedDiff}
                kind="write"
                filePath={filePath}
                content={args.content}
              />
            )}

            {/* Multi-edit */}
            {args.edits && Array.isArray(args.edits) && (
              <AdvancedDiffRenderer
                precomputed={precomputedDiff}
                kind="multi_edit"
                filePath={filePath}
                edits={args.edits.map(
                  (e: { old_string?: string; new_string?: string }) => ({
                    old_string: e.old_string || "",
                    new_string: e.new_string || "",
                  }),
                )}
              />
            )}

            {/* Single edit */}
            {args.old_string !== undefined && !args.edits && (
              <AdvancedDiffRenderer
                precomputed={precomputedDiff}
                kind="edit"
                filePath={filePath}
                oldString={args.old_string || ""}
                newString={args.new_string || ""}
                replaceAll={args.replace_all}
              />
            )}

            <Text dimColor>{dottedLine}</Text>
          </Box>
        );
      } catch {
        // Fall through to generic
      }
    }

    // Generic fallback
    return (
      <Box flexDirection="column">
        <Text dimColor>{solidLine}</Text>
        <Text bold color={colors.approval.header}>
          {toolName} requires approval
        </Text>
        <Text dimColor>{dottedLine}</Text>
      </Box>
    );
  },
);

ApprovalPreview.displayName = "ApprovalPreview";
