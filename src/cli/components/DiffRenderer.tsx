import { relative } from "node:path";
import * as Diff from "diff";
import { Box, Text } from "ink";
import { colors } from "./colors";

// Helper to format path as relative with ../
function formatRelativePath(filePath: string): string {
  const cwd = process.cwd();
  const relativePath = relative(cwd, filePath);

  // If file is outside cwd, it will start with ..
  // If file is in cwd, add ./ prefix
  if (!relativePath.startsWith("..")) {
    return `./${relativePath}`;
  }
  return relativePath;
}

// Helper to count lines in a string
function countLines(str: string): number {
  if (!str) return 0;
  return str.split("\n").length;
}

// Helper to render a diff line with word-level highlighting
interface DiffLineProps {
  lineNumber: number;
  type: "add" | "remove";
  content: string;
  compareContent?: string; // The other version to compare against for word diff
}

function DiffLine({
  lineNumber,
  type,
  content,
  compareContent,
}: DiffLineProps) {
  const prefix = type === "add" ? "+" : "-";
  const lineBg =
    type === "add" ? colors.diff.addedLineBg : colors.diff.removedLineBg;
  const wordBg =
    type === "add" ? colors.diff.addedWordBg : colors.diff.removedWordBg;

  // If we have something to compare against, do word-level diff
  if (compareContent !== undefined && content.trim() && compareContent.trim()) {
    const wordDiffs =
      type === "add"
        ? Diff.diffWords(compareContent, content)
        : Diff.diffWords(content, compareContent);

    return (
      <Box>
        <Text> </Text>
        <Text backgroundColor={lineBg} color={colors.diff.textOnDark}>
          {`${lineNumber} ${prefix}  `}
        </Text>
        {wordDiffs.map((part, i) => {
          if (part.added && type === "add") {
            // This part was added (show with brighter background, black text)
            return (
              <Text
                key={`word-${i}-${part.value.substring(0, 10)}`}
                backgroundColor={wordBg}
                color={colors.diff.textOnHighlight}
              >
                {part.value}
              </Text>
            );
          } else if (part.removed && type === "remove") {
            // This part was removed (show with brighter background, black text)
            return (
              <Text
                key={`word-${i}-${part.value.substring(0, 10)}`}
                backgroundColor={wordBg}
                color={colors.diff.textOnHighlight}
              >
                {part.value}
              </Text>
            );
          } else if (!part.added && !part.removed) {
            // Unchanged part (show with line background, white text)
            return (
              <Text
                key={`word-${i}-${part.value.substring(0, 10)}`}
                backgroundColor={lineBg}
                color={colors.diff.textOnDark}
              >
                {part.value}
              </Text>
            );
          }
          // Skip parts that don't belong in this line
          return null;
        })}
      </Box>
    );
  }

  // No comparison, just show the whole line with one background
  return (
    <Box>
      <Text> </Text>
      <Text backgroundColor={lineBg} color={colors.diff.textOnDark}>
        {`${lineNumber} ${prefix}  ${content}`}
      </Text>
    </Box>
  );
}

interface WriteRendererProps {
  filePath: string;
  content: string;
}

export function WriteRenderer({ filePath, content }: WriteRendererProps) {
  const relativePath = formatRelativePath(filePath);
  const lines = content.split("\n");
  const lineCount = lines.length;

  return (
    <Box flexDirection="column">
      <Text>
        {" "}
        ⎿ Wrote {lineCount} line{lineCount !== 1 ? "s" : ""} to {relativePath}
      </Text>
      {lines.map((line, i) => (
        <Text key={`line-${i}-${line.substring(0, 20)}`}> {line}</Text>
      ))}
    </Box>
  );
}

interface EditRendererProps {
  filePath: string;
  oldString: string;
  newString: string;
}

export function EditRenderer({
  filePath,
  oldString,
  newString,
}: EditRendererProps) {
  const relativePath = formatRelativePath(filePath);
  const oldLines = oldString.split("\n");
  const newLines = newString.split("\n");

  // For the summary
  const additions = newLines.length;
  const removals = oldLines.length;

  // Try to match up lines for word-level diff
  // This is a simple approach - for single-line changes, compare directly
  // For multi-line, we could do more sophisticated matching
  const singleLineEdit = oldLines.length === 1 && newLines.length === 1;

  return (
    <Box flexDirection="column">
      <Text>
        {" "}
        ⎿ Updated {relativePath} with {additions} addition
        {additions !== 1 ? "s" : ""} and {removals} removal
        {removals !== 1 ? "s" : ""}
      </Text>

      {/* Show removals */}
      {oldLines.map((line, i) => (
        <DiffLine
          key={`old-${i}-${line.substring(0, 20)}`}
          lineNumber={i + 1}
          type="remove"
          content={line}
          compareContent={singleLineEdit ? newLines[0] : undefined}
        />
      ))}

      {/* Show additions */}
      {newLines.map((line, i) => (
        <DiffLine
          key={`new-${i}-${line.substring(0, 20)}`}
          lineNumber={i + 1}
          type="add"
          content={line}
          compareContent={singleLineEdit ? oldLines[0] : undefined}
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
}

export function MultiEditRenderer({ filePath, edits }: MultiEditRendererProps) {
  const relativePath = formatRelativePath(filePath);

  // Count total additions and removals
  let totalAdditions = 0;
  let totalRemovals = 0;

  edits.forEach((edit) => {
    totalAdditions += countLines(edit.new_string);
    totalRemovals += countLines(edit.old_string);
  });

  return (
    <Box flexDirection="column">
      <Text>
        {" "}
        ⎿ Updated {relativePath} with {totalAdditions} addition
        {totalAdditions !== 1 ? "s" : ""} and {totalRemovals} removal
        {totalRemovals !== 1 ? "s" : ""}
      </Text>

      {/* For multi-edit, show each edit sequentially */}
      {edits.map((edit, index) => {
        const oldLines = edit.old_string.split("\n");
        const newLines = edit.new_string.split("\n");
        const singleLineEdit = oldLines.length === 1 && newLines.length === 1;

        return (
          <Box
            key={`edit-${index}-${edit.old_string.substring(0, 20)}-${edit.new_string.substring(0, 20)}`}
            flexDirection="column"
          >
            {oldLines.map((line, i) => (
              <DiffLine
                key={`old-${index}-${i}-${line.substring(0, 20)}`}
                lineNumber={i + 1} // TODO: This should be actual file line numbers
                type="remove"
                content={line}
                compareContent={
                  singleLineEdit && i === 0 ? newLines[0] : undefined
                }
              />
            ))}
            {newLines.map((line, i) => (
              <DiffLine
                key={`new-${index}-${i}-${line.substring(0, 20)}`}
                lineNumber={i + 1} // TODO: This should be actual file line numbers
                type="add"
                content={line}
                compareContent={
                  singleLineEdit && i === 0 ? oldLines[0] : undefined
                }
              />
            ))}
          </Box>
        );
      })}
    </Box>
  );
}
