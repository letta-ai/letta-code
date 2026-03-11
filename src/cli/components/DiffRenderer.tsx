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

// A styled text chunk with optional color/dim for row-splitting.
type StyledChunk = { text: string; color?: string; dimColor?: boolean };

// Split styled chunks into rows of exactly `cols` characters, padding the last row.
// Continuation rows start with a blank indent of `contIndent` characters
// (matching Codex's empty-gutter + 2-space continuation, diff_render.rs:922-929).
function buildPaddedRows(
  chunks: StyledChunk[],
  cols: number,
  contIndent: number,
): StyledChunk[][] {
  if (cols <= 0) return [chunks];
  const rows: StyledChunk[][] = [];
  let row: StyledChunk[] = [];
  let len = 0;
  for (const chunk of chunks) {
    let rem = chunk.text;
    while (rem.length > 0) {
      const space = cols - len;
      if (rem.length <= space) {
        row.push({ text: rem, color: chunk.color, dimColor: chunk.dimColor });
        len += rem.length;
        rem = "";
      } else {
        row.push({
          text: rem.slice(0, space),
          color: chunk.color,
          dimColor: chunk.dimColor,
        });
        rows.push(row);
        // Start continuation row with blank gutter indent
        row = [{ text: " ".repeat(contIndent) }];
        len = contIndent;
        rem = rem.slice(space);
      }
    }
  }
  if (len < cols) row.push({ text: " ".repeat(cols - len) });
  if (row.length > 0) rows.push(row);
  return rows;
}

// Render a single diff line split into full-width rows.
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
  const symbolColor =
    type === "add" ? colors.diff.symbolAdd : colors.diff.symbolRemove;
  const lineBg =
    type === "add" ? colors.diff.addedLineBg : colors.diff.removedLineBg;
  const prefix = type === "add" ? "+" : "-";

  // Build styled chunks for the full line.
  const indent = "    ";
  const numStr = showLineNumbers ? `${lineNumber} ` : "";
  const chunks: StyledChunk[] = [{ text: indent }];
  if (showLineNumbers) chunks.push({ text: numStr, dimColor: true });
  chunks.push({ text: prefix, color: symbolColor });
  chunks.push({ text: "  " }); // gap after sign
  if (syntaxSpans && syntaxSpans.length > 0) {
    for (const span of syntaxSpans) {
      chunks.push({ text: span.text, color: span.color });
    }
  } else {
    chunks.push({ text: content });
  }

  // Continuation indent = indent + lineNum + sign + gap (blank, same width)
  const contIndent = indent.length + numStr.length + 1 + 2;
  const rows = buildPaddedRows(chunks, columns, contIndent);

  return (
    <>
      {rows.map((row, ri) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows are static, never reorder
        <Text key={ri} backgroundColor={lineBg} dimColor={type === "remove"}>
          {row.map((c, ci) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: chunks are static
            <Text key={ci} color={c.color} dimColor={c.dimColor}>
              {c.text}
            </Text>
          ))}
        </Text>
      ))}
    </>
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
