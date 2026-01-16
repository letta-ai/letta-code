import * as Diff from "diff";
import { Box, Text } from "ink";
import { useTerminalWidth } from "../hooks/useTerminalWidth";
import { colors } from "./colors";

interface MemoryDiffRendererProps {
  argsText: string;
  toolName: string;
}

/**
 * Renders a diff view for memory tool operations.
 * Handles both `memory` (command-based) and `memory_apply_patch` (unified diff) tools.
 */
export function MemoryDiffRenderer({
  argsText,
  toolName,
}: MemoryDiffRendererProps) {
  const columns = useTerminalWidth();

  try {
    const args = JSON.parse(argsText);

    // Handle memory_apply_patch tool (unified diff format)
    if (toolName === "memory_apply_patch") {
      const label = args.label || "unknown";
      const patch = args.patch || "";
      return (
        <PatchDiffRenderer label={label} patch={patch} columns={columns} />
      );
    }

    // Handle memory tool (command-based)
    const command = args.command as string;
    const path = args.path || args.old_path || "unknown";

    // Extract just the block name from the path (e.g., "/memories/project" -> "project")
    const blockName = path.split("/").pop() || path;

    switch (command) {
      case "str_replace": {
        const oldStr = args.old_string || "";
        const newStr = args.new_string || "";
        return (
          <MemoryStrReplaceDiff
            blockName={blockName}
            oldStr={oldStr}
            newStr={newStr}
            columns={columns}
          />
        );
      }

      case "insert": {
        const insertText = args.insert_text || "";
        const insertLine = args.insert_line;
        const prefixWidth = 4; // "    " indent
        const contentWidth = Math.max(0, columns - prefixWidth);
        return (
          <Box flexDirection="column">
            <Box flexDirection="row">
              <Box width={prefixWidth} flexShrink={0}>
                <Text>
                  {"  "}
                  <Text dimColor>⎿</Text>
                </Text>
              </Box>
              <Box flexGrow={1} width={contentWidth}>
                <Text wrap="wrap">
                  Inserted into memory block{" "}
                  <Text bold color={colors.tool.memoryName}>
                    {blockName}
                  </Text>
                  {insertLine !== undefined && ` at line ${insertLine}`}
                </Text>
              </Box>
            </Box>
            {insertText.split("\n").map((line: string, i: number) => (
              <Box
                key={`insert-${i}-${line.substring(0, 20)}`}
                flexDirection="row"
              >
                <Box width={prefixWidth} flexShrink={0}>
                  <Text>{"    "}</Text>
                </Box>
                <Box flexGrow={1} width={contentWidth}>
                  <Text
                    backgroundColor={colors.diff.addedLineBg}
                    color={colors.diff.textOnDark}
                    wrap="wrap"
                  >
                    {`+ ${line}`}
                  </Text>
                </Box>
              </Box>
            ))}
          </Box>
        );
      }

      case "create": {
        const description = args.description || "";
        const fileText = args.file_text || "";
        const prefixWidth = 4; // "    " indent
        const contentWidth = Math.max(0, columns - prefixWidth);
        return (
          <Box flexDirection="column">
            <Box flexDirection="row">
              <Box width={prefixWidth} flexShrink={0}>
                <Text>
                  {"  "}
                  <Text dimColor>⎿</Text>
                </Text>
              </Box>
              <Box flexGrow={1} width={contentWidth}>
                <Text wrap="wrap">
                  Created memory block{" "}
                  <Text bold color={colors.tool.memoryName}>
                    {blockName}
                  </Text>
                  {description && (
                    <Text dimColor> - {truncate(description, 40)}</Text>
                  )}
                </Text>
              </Box>
            </Box>
            {fileText
              ?.split("\n")
              .slice(0, 3)
              .map((line: string, i: number) => (
                <Box
                  key={`create-${i}-${line.substring(0, 20)}`}
                  flexDirection="row"
                >
                  <Box width={prefixWidth} flexShrink={0}>
                    <Text>{"    "}</Text>
                  </Box>
                  <Box flexGrow={1} width={contentWidth}>
                    <Text
                      backgroundColor={colors.diff.addedLineBg}
                      color={colors.diff.textOnDark}
                      wrap="wrap"
                    >
                      {`+ ${truncate(line, 60)}`}
                    </Text>
                  </Box>
                </Box>
              ))}
            {fileText && fileText.split("\n").length > 3 && (
              <Text dimColor>
                {"    "}... and {fileText.split("\n").length - 3} more lines
              </Text>
            )}
          </Box>
        );
      }

      case "delete": {
        const prefixWidth = 4;
        const contentWidth = Math.max(0, columns - prefixWidth);
        return (
          <Box flexDirection="row">
            <Box width={prefixWidth} flexShrink={0}>
              <Text>
                {"  "}
                <Text dimColor>⎿</Text>
              </Text>
            </Box>
            <Box flexGrow={1} width={contentWidth}>
              <Text wrap="wrap">
                Deleted memory block{" "}
                <Text bold color={colors.tool.memoryName}>
                  {blockName}
                </Text>
              </Text>
            </Box>
          </Box>
        );
      }

      case "rename": {
        const newPath = args.new_path || "";
        const newBlockName = newPath.split("/").pop() || newPath;
        const description = args.description;
        const prefixWidth = 4;
        const contentWidth = Math.max(0, columns - prefixWidth);
        if (description) {
          return (
            <Box flexDirection="row">
              <Box width={prefixWidth} flexShrink={0}>
                <Text>
                  {"  "}
                  <Text dimColor>⎿</Text>
                </Text>
              </Box>
              <Box flexGrow={1} width={contentWidth}>
                <Text wrap="wrap">
                  Updated description of{" "}
                  <Text bold color={colors.tool.memoryName}>
                    {blockName}
                  </Text>
                </Text>
              </Box>
            </Box>
          );
        }
        return (
          <Box flexDirection="row">
            <Box width={prefixWidth} flexShrink={0}>
              <Text>
                {"  "}
                <Text dimColor>⎿</Text>
              </Text>
            </Box>
            <Box flexGrow={1} width={contentWidth}>
              <Text wrap="wrap">
                Renamed{" "}
                <Text bold color={colors.tool.memoryName}>
                  {blockName}
                </Text>{" "}
                to{" "}
                <Text bold color={colors.tool.memoryName}>
                  {newBlockName}
                </Text>
              </Text>
            </Box>
          </Box>
        );
      }

      default: {
        const defaultPrefixWidth = 4;
        const defaultContentWidth = Math.max(0, columns - defaultPrefixWidth);
        return (
          <Box flexDirection="row">
            <Box width={defaultPrefixWidth} flexShrink={0}>
              <Text>
                {"  "}
                <Text dimColor>⎿</Text>
              </Text>
            </Box>
            <Box flexGrow={1} width={defaultContentWidth}>
              <Text wrap="wrap">
                Memory operation: {command} on{" "}
                <Text bold color={colors.tool.memoryName}>
                  {blockName}
                </Text>
              </Text>
            </Box>
          </Box>
        );
      }
    }
  } catch {
    // If parsing fails, return null to fall through to regular handling
    return null;
  }
}

/**
 * Renders a str_replace diff with line-level diffing and word-level highlighting.
 * Uses Diff.diffLines() to only show lines that actually changed,
 * instead of showing all old lines then all new lines.
 */
function MemoryStrReplaceDiff({
  blockName,
  oldStr,
  newStr,
  columns,
}: {
  blockName: string;
  oldStr: string;
  newStr: string;
  columns: number;
}) {
  // Use line-level diff to find what actually changed
  const lineDiffs = Diff.diffLines(oldStr, newStr);

  // Build display rows: only show added/removed lines, not unchanged
  // For adjacent remove/add pairs, enable word-level highlighting
  type DiffRow = {
    type: "add" | "remove";
    content: string;
    pairContent?: string; // For word-level diff when remove is followed by add
  };
  const rows: DiffRow[] = [];

  for (let i = 0; i < lineDiffs.length; i++) {
    const part = lineDiffs[i];
    if (!part) continue;

    // Skip unchanged lines (context)
    if (!part.added && !part.removed) continue;

    // Split the value into individual lines (remove trailing newline)
    const lines = part.value.replace(/\n$/, "").split("\n");

    if (part.removed) {
      // Check if next part is an addition (for word-level diff pairing)
      const nextPart = lineDiffs[i + 1];
      const nextIsAdd = nextPart?.added;
      const nextLines = nextIsAdd
        ? nextPart.value.replace(/\n$/, "").split("\n")
        : [];

      lines.forEach((line, lineIdx) => {
        rows.push({
          type: "remove",
          content: line,
          // Pair with corresponding add line for word-level diff (if same count)
          pairContent:
            nextIsAdd && lines.length === nextLines.length
              ? nextLines[lineIdx]
              : undefined,
        });
      });
    } else if (part.added) {
      // Check if previous part was a removal (already handled pairing above)
      const prevPart = lineDiffs[i - 1];
      const prevIsRemove = prevPart?.removed;
      const prevLines = prevIsRemove
        ? prevPart.value.replace(/\n$/, "").split("\n")
        : [];

      lines.forEach((line, lineIdx) => {
        rows.push({
          type: "add",
          content: line,
          // Pair with corresponding remove line for word-level diff (if same count)
          pairContent:
            prevIsRemove && lines.length === prevLines.length
              ? prevLines[lineIdx]
              : undefined,
        });
      });
    }
  }

  // Limit display to avoid huge diffs
  const maxRows = 10;
  const displayRows = rows.slice(0, maxRows);
  const hasMore = rows.length > maxRows;

  const prefixWidth = 4;
  const contentWidth = Math.max(0, columns - prefixWidth);

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Box width={prefixWidth} flexShrink={0}>
          <Text>
            {"  "}
            <Text dimColor>⎿</Text>
          </Text>
        </Box>
        <Box flexGrow={1} width={contentWidth}>
          <Text wrap="wrap">
            Updated memory block{" "}
            <Text bold color={colors.tool.memoryName}>
              {blockName}
            </Text>
          </Text>
        </Box>
      </Box>

      {displayRows.map((row, i) => (
        <DiffLine
          key={`diff-${i}-${row.type}-${row.content.substring(0, 20)}`}
          type={row.type}
          content={row.content}
          compareContent={row.pairContent}
          columns={columns}
        />
      ))}

      {hasMore && (
        <Text dimColor>
          {"    "}... {rows.length - maxRows} more lines
        </Text>
      )}
    </Box>
  );
}

/**
 * Single diff line with word-level highlighting
 */
function DiffLine({
  type,
  content,
  compareContent,
  columns,
}: {
  type: "add" | "remove";
  content: string;
  compareContent?: string;
  columns: number;
}) {
  const prefix = type === "add" ? "+" : "-";
  const lineBg =
    type === "add" ? colors.diff.addedLineBg : colors.diff.removedLineBg;
  const wordBg =
    type === "add" ? colors.diff.addedWordBg : colors.diff.removedWordBg;

  const prefixWidth = 4; // "    " indent
  const contentWidth = Math.max(0, columns - prefixWidth);

  // Word-level diff if we have something to compare
  if (compareContent !== undefined && content.trim() && compareContent.trim()) {
    const wordDiffs =
      type === "add"
        ? Diff.diffWords(compareContent, content)
        : Diff.diffWords(content, compareContent);

    return (
      <Box flexDirection="row">
        <Box width={prefixWidth} flexShrink={0}>
          <Text>{"    "}</Text>
        </Box>
        <Box flexGrow={1} width={contentWidth}>
          <Text wrap="wrap">
            <Text backgroundColor={lineBg} color={colors.diff.textOnDark}>
              {`${prefix} `}
            </Text>
            {wordDiffs.map((part, i) => {
              if (part.added && type === "add") {
                return (
                  <Text
                    key={`w-${i}-${part.value.substring(0, 10)}`}
                    backgroundColor={wordBg}
                    color={colors.diff.textOnHighlight}
                  >
                    {part.value}
                  </Text>
                );
              } else if (part.removed && type === "remove") {
                return (
                  <Text
                    key={`w-${i}-${part.value.substring(0, 10)}`}
                    backgroundColor={wordBg}
                    color={colors.diff.textOnHighlight}
                  >
                    {part.value}
                  </Text>
                );
              } else if (!part.added && !part.removed) {
                return (
                  <Text
                    key={`w-${i}-${part.value.substring(0, 10)}`}
                    backgroundColor={lineBg}
                    color={colors.diff.textOnDark}
                  >
                    {part.value}
                  </Text>
                );
              }
              return null;
            })}
          </Text>
        </Box>
      </Box>
    );
  }

  // Simple line without word diff
  return (
    <Box flexDirection="row">
      <Box width={prefixWidth} flexShrink={0}>
        <Text>{"    "}</Text>
      </Box>
      <Box flexGrow={1} width={contentWidth}>
        <Text
          backgroundColor={lineBg}
          color={colors.diff.textOnDark}
          wrap="wrap"
        >
          {`${prefix} ${content}`}
        </Text>
      </Box>
    </Box>
  );
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return `${str.slice(0, maxLen - 1)}…`;
}

/**
 * Renders a unified-diff patch from memory_apply_patch tool
 */
function PatchDiffRenderer({
  label,
  patch,
  columns,
}: {
  label: string;
  patch: string;
  columns: number;
}) {
  const lines = patch.split("\n");
  const maxLines = 8;
  const displayLines = lines.slice(0, maxLines);
  const hasMore = lines.length > maxLines;

  const prefixWidth = 4; // "    " indent
  const contentWidth = Math.max(0, columns - prefixWidth);

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Box width={prefixWidth} flexShrink={0}>
          <Text>
            {"  "}
            <Text dimColor>⎿</Text>
          </Text>
        </Box>
        <Box flexGrow={1} width={contentWidth}>
          <Text wrap="wrap">
            Patched memory block{" "}
            <Text bold color={colors.tool.memoryName}>
              {label}
            </Text>
          </Text>
        </Box>
      </Box>
      {displayLines.map((line, i) => {
        // Skip @@ hunk headers
        if (line.startsWith("@@")) {
          return null;
        }

        const firstChar = line[0];
        const content = line.slice(1); // Remove the prefix character

        if (firstChar === "+") {
          return (
            <Box
              key={`patch-${i}-${line.substring(0, 20)}`}
              flexDirection="row"
            >
              <Box width={prefixWidth} flexShrink={0}>
                <Text>{"    "}</Text>
              </Box>
              <Box flexGrow={1} width={contentWidth}>
                <Text
                  backgroundColor={colors.diff.addedLineBg}
                  color={colors.diff.textOnDark}
                  wrap="wrap"
                >
                  {`+ ${content}`}
                </Text>
              </Box>
            </Box>
          );
        } else if (firstChar === "-") {
          return (
            <Box
              key={`patch-${i}-${line.substring(0, 20)}`}
              flexDirection="row"
            >
              <Box width={prefixWidth} flexShrink={0}>
                <Text>{"    "}</Text>
              </Box>
              <Box flexGrow={1} width={contentWidth}>
                <Text
                  backgroundColor={colors.diff.removedLineBg}
                  color={colors.diff.textOnDark}
                  wrap="wrap"
                >
                  {`- ${content}`}
                </Text>
              </Box>
            </Box>
          );
        } else if (firstChar === " ") {
          // Context line - show dimmed
          return (
            <Box
              key={`patch-${i}-${line.substring(0, 20)}`}
              flexDirection="row"
            >
              <Box width={prefixWidth + 2} flexShrink={0}>
                <Text dimColor>{"      "}</Text>
              </Box>
              <Box flexGrow={1} width={Math.max(0, columns - prefixWidth - 2)}>
                <Text dimColor wrap="wrap">
                  {content}
                </Text>
              </Box>
            </Box>
          );
        }
        // Unknown format, show as-is
        return (
          <Box key={`patch-${i}-${line.substring(0, 20)}`} flexDirection="row">
            <Box width={prefixWidth} flexShrink={0}>
              <Text dimColor>{"    "}</Text>
            </Box>
            <Box flexGrow={1} width={contentWidth}>
              <Text dimColor wrap="wrap">
                {line}
              </Text>
            </Box>
          </Box>
        );
      })}
      {hasMore && (
        <Text dimColor>
          {"    "}... {lines.length - maxLines} more lines
        </Text>
      )}
    </Box>
  );
}
