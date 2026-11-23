import * as Diff from "diff";
import { Box } from "ink";
import { CLI_GLYPHS } from "@/cli/helpers/glyphs";
import { useTerminalWidth } from "@/cli/hooks/use-terminal-width";
import { colors } from "./colors";
import { Text } from "./Text";

interface MemoryDiffRendererProps {
  argsText: string;
  toolName: string;
}

function stringArg(
  args: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function memoryBlockName(path: string): string {
  return path.split("/").pop() || path;
}

export function MemoryDiffRenderer({
  argsText,
  toolName,
}: MemoryDiffRendererProps) {
  const columns = useTerminalWidth();

  try {
    const args = JSON.parse(argsText) as Record<string, unknown>;

    if (toolName === "memory_apply_patch") {
      const patch = typeof args.input === "string" ? args.input : "";
      return (
        <PatchDiffRenderer label="memory" patch={patch} columns={columns} />
      );
    }

    const command = args.command as string;
    const path = stringArg(args, "file_path", "path", "old_path") ?? "unknown";

    const blockName = memoryBlockName(path);

    switch (command) {
      case "str_replace": {
        const oldStr = stringArg(args, "old_string", "old_str") ?? "";
        const newStr = stringArg(args, "new_string", "new_str") ?? "";
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
        const insertText = stringArg(args, "insert_text") ?? "";
        const insertLine = args.insert_line;
        const prefixWidth = 4;
        const contentWidth = Math.max(0, columns - prefixWidth);
        return (
          <Box flexDirection="column">
            <Box flexDirection="row">
              <Box width={prefixWidth} flexShrink={0}>
                <Text>
                  {"  "}
                  <Text dimColor>{CLI_GLYPHS.result}</Text>
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
        const description = stringArg(args, "description") ?? "";
        const fileText = stringArg(args, "file_text") ?? "";
        const prefixWidth = 4;
        const contentWidth = Math.max(0, columns - prefixWidth);
        return (
          <Box flexDirection="column">
            <Box flexDirection="row">
              <Box width={prefixWidth} flexShrink={0}>
                <Text>
                  {"  "}
                  <Text dimColor>{CLI_GLYPHS.result}</Text>
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
                <Text dimColor>{CLI_GLYPHS.result}</Text>
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
        const newPath = stringArg(args, "new_path") ?? "";
        const newBlockName = memoryBlockName(newPath);
        const description = args.description;
        const prefixWidth = 4;
        const contentWidth = Math.max(0, columns - prefixWidth);
        if (description) {
          return (
            <Box flexDirection="row">
              <Box width={prefixWidth} flexShrink={0}>
                <Text>
                  {"  "}
                  <Text dimColor>{CLI_GLYPHS.result}</Text>
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
                <Text dimColor>{CLI_GLYPHS.result}</Text>
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
                <Text dimColor>{CLI_GLYPHS.result}</Text>
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
    return null;
  }
}

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
  const lineDiffs = Diff.diffLines(oldStr, newStr);

  type DiffRow = {
    type: "add" | "remove";
    content: string;
    pairContent?: string;
  };
  const rows: DiffRow[] = [];

  for (let i = 0; i < lineDiffs.length; i++) {
    const part = lineDiffs[i];
    if (!part) continue;

    if (!part.added && !part.removed) continue;

    const lines = part.value.replace(/\n$/, "").split("\n");

    if (part.removed) {
      const nextPart = lineDiffs[i + 1];
      const nextIsAdd = nextPart?.added;
      const nextLines = nextIsAdd
        ? nextPart.value.replace(/\n$/, "").split("\n")
        : [];

      lines.forEach((line, lineIdx) => {
        rows.push({
          type: "remove",
          content: line,
          pairContent:
            nextIsAdd && lines.length === nextLines.length
              ? nextLines[lineIdx]
              : undefined,
        });
      });
    } else if (part.added) {
      const prevPart = lineDiffs[i - 1];
      const prevIsRemove = prevPart?.removed;
      const prevLines = prevIsRemove
        ? prevPart.value.replace(/\n$/, "").split("\n")
        : [];

      lines.forEach((line, lineIdx) => {
        rows.push({
          type: "add",
          content: line,
          pairContent:
            prevIsRemove && lines.length === prevLines.length
              ? prevLines[lineIdx]
              : undefined,
        });
      });
    }
  }

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
            <Text dimColor>{CLI_GLYPHS.result}</Text>
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

  const prefixWidth = 4;
  const contentWidth = Math.max(0, columns - prefixWidth);

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

  const prefixWidth = 4;
  const contentWidth = Math.max(0, columns - prefixWidth);

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Box width={prefixWidth} flexShrink={0}>
          <Text>
            {"  "}
            <Text dimColor>{CLI_GLYPHS.result}</Text>
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
        if (line.startsWith("@@")) {
          return null;
        }

        const firstChar = line[0];
        const content = line.slice(1);

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
