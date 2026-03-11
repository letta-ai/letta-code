import { relative } from "node:path";
import { Box } from "ink";
import { useTerminalWidth } from "../hooks/useTerminalWidth";
import { colors } from "./colors";
import {
  highlightCode,
  languageFromPath,
  type StyledSpan,
} from "./SyntaxHighlightedCommand";
import { Text } from "./Text";

/**
 * Formats a file path for display (matches Claude Code style):
 * - Files within cwd: relative path without ./ prefix
 * - Files outside cwd: full absolute path
 */
function formatDisplayPath(filePath: string): string {
  const cwd = process.cwd();
  const relativePath = relative(cwd, filePath);
  if (relativePath.startsWith("..")) {
    return filePath;
  }
  return relativePath;
}

function countLines(str: string): number {
  if (!str) return 0;
  return str.split("\n").length;
}

// Render a single diff line with Codex-style full-line background and dimmed deletes.
// Trailing spaces pad the background to the right terminal edge.
interface DiffLineProps {
  lineNumber: number;
  type: "add" | "remove";
  content: string;
  syntaxSpans?: StyledSpan[];
  showLineNumbers?: boolean;
  columns: number;
}

function DiffLine({
  lineNumber,
  type,
  content,
  syntaxSpans,
  showLineNumbers = true,
  columns,
}: DiffLineProps) {
  const prefix = type === "add" ? "+" : "-";
  const symbolColor =
    type === "add" ? colors.diff.symbolAdd : colors.diff.symbolRemove;
  const lineBg =
    type === "add" ? colors.diff.addedLineBg : colors.diff.removedLineBg;

  // Left indent (tool-result gutter) is inside the bg so color is edge-to-edge.
  const indent = "    ";

  // Compute visible character count so we can pad to fill the terminal width.
  const numPrefix = showLineNumbers ? `${lineNumber} ` : "";
  const signAndGap = `${prefix}  `; // sign + 2 spaces
  const textLen =
    syntaxSpans?.reduce((sum, s) => sum + s.text.length, 0) ?? content.length;
  const visibleLen =
    indent.length + numPrefix.length + signAndGap.length + textLen;
  const trailingPad = Math.max(0, columns - visibleLen);

  return (
    <Text backgroundColor={lineBg} dimColor={type === "remove"}>
      {indent}
      {showLineNumbers ? <Text dimColor>{lineNumber} </Text> : null}
      <Text color={symbolColor}>{prefix}</Text>
      {"  "}
      {syntaxSpans && syntaxSpans.length > 0
        ? syntaxSpans.map((span, i) => (
            <Text
              key={`${i}:${span.color}:${span.text.substring(0, 12)}`}
              color={span.color}
            >
              {span.text}
            </Text>
          ))
        : content}
      {trailingPad > 0 ? " ".repeat(trailingPad) : null}
    </Text>
  );
}

interface WriteRendererProps {
  filePath: string;
  content: string;
}

export function WriteRenderer({ filePath, content }: WriteRendererProps) {
  const columns = useTerminalWidth();
  const relativePath = formatDisplayPath(filePath);
  const lines = content.split("\n");
  const lineCount = lines.length;

  const gutterWidth = 4; // "    " indent to align with tool return prefix
  const contentWidth = Math.max(0, columns - gutterWidth);

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Box width={gutterWidth} flexShrink={0}>
          <Text>
            {"  "}
            <Text dimColor>⎿</Text>
          </Text>
        </Box>
        <Box flexGrow={1} width={contentWidth}>
          <Text wrap="wrap">
            Wrote <Text bold>{lineCount}</Text> line
            {lineCount !== 1 ? "s" : ""} to <Text bold>{relativePath}</Text>
          </Text>
        </Box>
      </Box>
      {lines.map((line, i) => (
        <Box key={`line-${i}-${line.substring(0, 20)}`} flexDirection="row">
          <Box width={gutterWidth} flexShrink={0}>
            <Text>{"    "}</Text>
          </Box>
          <Box flexGrow={1} width={contentWidth}>
            <Text wrap="wrap">{line}</Text>
          </Box>
        </Box>
      ))}
    </Box>
  );
}

interface EditRendererProps {
  filePath: string;
  oldString: string;
  newString: string;
  showLineNumbers?: boolean; // Whether to show line numbers (default true)
}

export function EditRenderer({
  filePath,
  oldString,
  newString,
  showLineNumbers = true,
}: EditRendererProps) {
  const columns = useTerminalWidth();
  const relativePath = formatDisplayPath(filePath);
  const oldLines = oldString.split("\n");
  const newLines = newString.split("\n");

  const additions = newLines.length;
  const removals = oldLines.length;

  // Highlight old and new blocks separately for syntax coloring.
  const lang = languageFromPath(filePath);
  const oldHighlighted = lang ? highlightCode(oldString, lang) : undefined;
  const newHighlighted = lang ? highlightCode(newString, lang) : undefined;

  const gutterWidth = 4;
  const contentWidth = Math.max(0, columns - gutterWidth);

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Box width={gutterWidth} flexShrink={0}>
          <Text>
            {"  "}
            <Text dimColor>⎿</Text>
          </Text>
        </Box>
        <Box flexGrow={1} width={contentWidth}>
          <Text wrap="wrap">
            Updated <Text bold>{relativePath}</Text> with{" "}
            <Text bold>{additions}</Text> addition
            {additions !== 1 ? "s" : ""} and <Text bold>{removals}</Text>{" "}
            removal
            {removals !== 1 ? "s" : ""}
          </Text>
        </Box>
      </Box>

      {oldLines.map((line, i) => (
        <DiffLine
          key={`old-${i}-${line.substring(0, 20)}`}
          lineNumber={i + 1}
          type="remove"
          content={line}
          syntaxSpans={oldHighlighted?.[i]}
          showLineNumbers={showLineNumbers}
          columns={columns}
        />
      ))}

      {newLines.map((line, i) => (
        <DiffLine
          key={`new-${i}-${line.substring(0, 20)}`}
          lineNumber={i + 1}
          type="add"
          content={line}
          syntaxSpans={newHighlighted?.[i]}
          showLineNumbers={showLineNumbers}
          columns={columns}
        />
      ))}
    </Box>
  );
}

interface MultiEditRendererProps {
  filePath: string;
  edits: Array<{
    old_string: string;
    new_string: string;
  }>;
  showLineNumbers?: boolean; // Whether to show line numbers (default true)
}

export function MultiEditRenderer({
  filePath,
  edits,
  showLineNumbers = true,
}: MultiEditRendererProps) {
  const columns = useTerminalWidth();
  const relativePath = formatDisplayPath(filePath);

  let totalAdditions = 0;
  let totalRemovals = 0;

  edits.forEach((edit) => {
    totalAdditions += countLines(edit.new_string);
    totalRemovals += countLines(edit.old_string);
  });

  const lang = languageFromPath(filePath);
  const gutterWidth = 4;
  const contentWidth = Math.max(0, columns - gutterWidth);

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Box width={gutterWidth} flexShrink={0}>
          <Text>
            {"  "}
            <Text dimColor>⎿</Text>
          </Text>
        </Box>
        <Box flexGrow={1} width={contentWidth}>
          <Text wrap="wrap">
            Updated <Text bold>{relativePath}</Text> with{" "}
            <Text bold>{totalAdditions}</Text> addition
            {totalAdditions !== 1 ? "s" : ""} and{" "}
            <Text bold>{totalRemovals}</Text> removal
            {totalRemovals !== 1 ? "s" : ""}
          </Text>
        </Box>
      </Box>

      {edits.map((edit, index) => {
        const oldLines = edit.old_string.split("\n");
        const newLines = edit.new_string.split("\n");
        const oldHighlighted = lang
          ? highlightCode(edit.old_string, lang)
          : undefined;
        const newHighlighted = lang
          ? highlightCode(edit.new_string, lang)
          : undefined;

        return (
          <Box
            key={`edit-${index}-${edit.old_string.substring(0, 20)}-${edit.new_string.substring(0, 20)}`}
            flexDirection="column"
          >
            {oldLines.map((line, i) => (
              <DiffLine
                key={`old-${index}-${i}-${line.substring(0, 20)}`}
                lineNumber={i + 1}
                type="remove"
                content={line}
                syntaxSpans={oldHighlighted?.[i]}
                showLineNumbers={showLineNumbers}
                columns={columns}
              />
            ))}
            {newLines.map((line, i) => (
              <DiffLine
                key={`new-${index}-${i}-${line.substring(0, 20)}`}
                lineNumber={i + 1}
                type="add"
                content={line}
                syntaxSpans={newHighlighted?.[i]}
                showLineNumbers={showLineNumbers}
                columns={columns}
              />
            ))}
          </Box>
        );
      })}
    </Box>
  );
}
