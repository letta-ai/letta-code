import { Box, Transform } from "ink";
import type React from "react";
import stringWidth from "string-width";
import { colors, hexToBgAnsi } from "./colors.js";
import { InlineMarkdown } from "./InlineMarkdownRenderer.js";
import { Text } from "./Text";

interface MarkdownDisplayProps {
  text: string;
  dimColor?: boolean;
  hangingIndent?: number; // indent for wrapped lines within a paragraph
  backgroundColor?: string; // background color for all text
  contentWidth?: number; // available width — used to pad lines to fill background
}

// Regex patterns for markdown elements (defined outside component to avoid re-creation)
const headerRegex = /^(#{1,6})\s+(.*)$/;
const codeBlockRegex = /^```(\w*)?$/;
const listItemRegex = /^(\s*)([*\-+]|\d+\.)\s+(.*)$/;
const blockquoteRegex = /^>\s*(.*)$/;
const hrRegex = /^[-*_]{3,}$/;
const tableRowRegex = /^\|(.+)\|$/;
const tableSeparatorRegex = /^\|[\s:]*[-]+[\s:]*(\|[\s:]*[-]+[\s:]*)+\|$/;

// Header styles lookup
const headerStyles: Record<
  number,
  { bold?: boolean; italic?: boolean; color?: string }
> = {
  1: { bold: true, color: colors.heading.primary },
  2: { bold: true, color: colors.heading.secondary },
  3: { bold: true },
};
const defaultHeaderStyle = { italic: true };

/**
 * Renders full markdown content using pure Ink components.
 * Based on Gemini CLI's approach - NO ANSI codes, NO marked-terminal!
 */

export const MarkdownDisplay: React.FC<MarkdownDisplayProps> = ({
  text,
  dimColor,
  hangingIndent = 0,
  backgroundColor,
  contentWidth,
}) => {
  if (!text) return null;

  // Build ANSI background code and line-padding helper for full-width backgrounds.
  // Transform callbacks receive already-rendered text (with ANSI codes from child Text
  // components), so appended spaces need their own ANSI background coloring.
  const bgAnsi = backgroundColor ? hexToBgAnsi(backgroundColor) : "";
  const padLine = (ln: string): string => {
    if (!contentWidth || !backgroundColor) return ln;
    const visWidth = stringWidth(ln);
    const pad = Math.max(0, contentWidth - visWidth);
    if (pad <= 0) return ln;
    return `${ln}${bgAnsi}${" ".repeat(pad)}\x1b[0m`;
  };

  const lines = text.split("\n");
  const contentBlocks: React.ReactNode[] = [];

  // Collapse excessive vertical whitespace. Ink treats each empty line we emit
  // as real terminal height; models sometimes produce multiple blank lines
  // (often whitespace-only) which reads as "CR/LF gaps".
  let lastWasEmpty = false;

  let inCodeBlock = false;
  let codeBlockContent: string[] = [];

  // Helper function to parse table cells from a row
  const parseTableCells = (row: string): string[] => {
    return row
      .slice(1, -1) // Remove leading and trailing |
      .split("|")
      .map((cell) => cell.trim());
  };

  // Helper function to render a table
  const renderTable = (
    tableLines: string[],
    startIndex: number,
  ): React.ReactNode => {
    if (tableLines.length < 2 || !tableLines[0]) return null;

    const headerRow = parseTableCells(tableLines[0]);
    const bodyRows = tableLines.slice(2).map(parseTableCells); // Skip separator row

    // Calculate column widths
    const colWidths = headerRow.map((header, colIdx) => {
      const bodyMax = bodyRows.reduce((max, row) => {
        const cell = row[colIdx] || "";
        return Math.max(max, cell.length);
      }, 0);
      return Math.max(header.length, bodyMax, 3); // Minimum 3 chars
    });

    return (
      <Box key={`table-${startIndex}`} flexDirection="column" marginY={0}>
        {/* Header row */}
        <Box flexDirection="row">
          <Text dimColor={dimColor} backgroundColor={backgroundColor}>
            │
          </Text>
          {headerRow.map((cell, idx) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static table content
            <Box key={`h-${idx}`} flexDirection="row">
              <Text bold dimColor={dimColor} backgroundColor={backgroundColor}>
                {" "}
                {cell.padEnd(colWidths[idx] ?? 3)}
              </Text>
              <Text dimColor={dimColor} backgroundColor={backgroundColor}>
                {" "}
                │
              </Text>
            </Box>
          ))}
        </Box>
        {/* Separator */}
        <Box flexDirection="row">
          <Text dimColor={dimColor} backgroundColor={backgroundColor}>
            ├
          </Text>
          {colWidths.map((width, idx) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static table content
            <Box key={`s-${idx}`} flexDirection="row">
              <Text dimColor={dimColor} backgroundColor={backgroundColor}>
                {"─".repeat(width + 2)}
              </Text>
              <Text dimColor={dimColor} backgroundColor={backgroundColor}>
                {idx < colWidths.length - 1 ? "┼" : "┤"}
              </Text>
            </Box>
          ))}
        </Box>
        {/* Body rows */}
        {bodyRows.map((row, rowIdx) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static table content
          <Box key={`r-${rowIdx}`} flexDirection="row">
            <Text dimColor={dimColor} backgroundColor={backgroundColor}>
              │
            </Text>
            {row.map((cell, colIdx) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static table content
              <Box key={`c-${colIdx}`} flexDirection="row">
                <Text dimColor={dimColor} backgroundColor={backgroundColor}>
                  {" "}
                  {(cell || "").padEnd(colWidths[colIdx] || 3)}
                </Text>
                <Text dimColor={dimColor} backgroundColor={backgroundColor}>
                  {" "}
                  │
                </Text>
              </Box>
            ))}
          </Box>
        ))}
      </Box>
    );
  };

  // Use index-based loop to handle multi-line elements (tables)
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] as string; // Safe: index < lines.length
    const key = `line-${index}`;

    // Any non-empty line breaks a run of empty lines.
    if (line.trim() !== "") {
      lastWasEmpty = false;
    }

    // Handle code blocks
    if (codeBlockRegex.test(line)) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeBlockContent = [];
      } else {
        inCodeBlock = false;
        const code = codeBlockContent.join("\n");
        contentBlocks.push(
          <Box key={key} paddingLeft={2}>
            <Text color={colors.code.inline} backgroundColor={backgroundColor}>
              {code}
              {backgroundColor ? "  " : null}
            </Text>
          </Box>,
        );
        codeBlockContent = [];
      }
      index++;
      continue;
    }

    // If we're inside a code block, collect the content
    if (inCodeBlock) {
      codeBlockContent.push(line);
      index++;
      continue;
    }

    // Check for headers
    const headerMatch = line.match(headerRegex);
    if (headerMatch?.[1] && headerMatch[2] !== undefined) {
      const level = headerMatch[1].length;
      const content = headerMatch[2];
      const style = headerStyles[level] ?? defaultHeaderStyle;

      contentBlocks.push(
        <Box key={key}>
          <Text {...style} backgroundColor={backgroundColor}>
            <InlineMarkdown
              text={content}
              dimColor={dimColor}
              backgroundColor={backgroundColor}
            />
            {backgroundColor ? "  " : null}
          </Text>
        </Box>,
      );
      index++;
      continue;
    }

    // Check for list items
    const listMatch = line.match(listItemRegex);
    if (
      listMatch &&
      listMatch[1] !== undefined &&
      listMatch[2] &&
      listMatch[3] !== undefined
    ) {
      const indent = listMatch[1].length;
      const marker = listMatch[2];
      const content = listMatch[3];

      // Preserve original marker for copy-paste compatibility
      const bullet = `${marker} `;
      const bulletWidth = bullet.length;

      contentBlocks.push(
        <Box key={key} paddingLeft={indent} flexDirection="row">
          <Box width={bulletWidth} flexShrink={0}>
            <Text dimColor={dimColor} backgroundColor={backgroundColor}>
              {bullet}
            </Text>
          </Box>
          <Box flexGrow={1}>
            <Text
              wrap="wrap"
              dimColor={dimColor}
              backgroundColor={backgroundColor}
            >
              <InlineMarkdown
                text={content}
                dimColor={dimColor}
                backgroundColor={backgroundColor}
              />
              {backgroundColor ? "  " : null}
            </Text>
          </Box>
        </Box>,
      );
      index++;
      continue;
    }

    // Check for blockquotes
    const blockquoteMatch = line.match(blockquoteRegex);
    if (blockquoteMatch && blockquoteMatch[1] !== undefined) {
      contentBlocks.push(
        <Box key={key} paddingLeft={2}>
          <Text dimColor backgroundColor={backgroundColor}>
            │{" "}
          </Text>
          <Text
            wrap="wrap"
            dimColor={dimColor}
            backgroundColor={backgroundColor}
          >
            <InlineMarkdown
              text={blockquoteMatch[1]}
              dimColor={dimColor}
              backgroundColor={backgroundColor}
            />
            {backgroundColor ? "  " : null}
          </Text>
        </Box>,
      );
      index++;
      continue;
    }

    // Check for horizontal rules
    if (line.match(hrRegex)) {
      contentBlocks.push(
        <Box key={key}>
          <Text dimColor backgroundColor={backgroundColor}>
            ───────────────────────────────
          </Text>
        </Box>,
      );
      index++;
      continue;
    }

    // Check for tables (must have | at start and end, and next line should be separator)
    const nextLine = lines[index + 1];
    if (
      tableRowRegex.test(line) &&
      nextLine &&
      tableSeparatorRegex.test(nextLine)
    ) {
      // Collect all table lines
      const tableLines: string[] = [line];
      let tableIdx = index + 1;
      while (tableIdx < lines.length) {
        const tableLine = lines[tableIdx];
        if (!tableLine || !tableRowRegex.test(tableLine)) break;
        tableLines.push(tableLine);
        tableIdx++;
      }
      // Also accept separator-only lines
      if (tableLines.length >= 2) {
        const tableElement = renderTable(tableLines, index);
        if (tableElement) {
          contentBlocks.push(tableElement);
        }
        index = tableIdx;
        continue;
      }
    }

    // Empty lines
    if (line.trim() === "") {
      if (lastWasEmpty) {
        index++;
        continue;
      }
      lastWasEmpty = true;
      if (backgroundColor) {
        // Render a visible space so outer Transform can pad this line
        contentBlocks.push(
          <Box key={key}>
            <Text backgroundColor={backgroundColor}> </Text>
          </Box>,
        );
      } else {
        contentBlocks.push(<Box key={key} height={1} />);
      }
      index++;
      continue;
    }

    // Regular paragraph text with optional hanging indent and line padding
    const needsTransform =
      hangingIndent > 0 || (contentWidth && backgroundColor);
    contentBlocks.push(
      <Box key={key}>
        {needsTransform ? (
          <Transform
            transform={(ln, i) => {
              const indented =
                hangingIndent > 0 && i > 0
                  ? " ".repeat(hangingIndent) + ln
                  : ln;
              return padLine(indented);
            }}
          >
            <Text
              wrap="wrap"
              dimColor={dimColor}
              backgroundColor={backgroundColor}
            >
              <InlineMarkdown
                text={line}
                dimColor={dimColor}
                backgroundColor={backgroundColor}
              />
            </Text>
          </Transform>
        ) : (
          <Text
            wrap="wrap"
            dimColor={dimColor}
            backgroundColor={backgroundColor}
          >
            <InlineMarkdown
              text={line}
              dimColor={dimColor}
              backgroundColor={backgroundColor}
            />
          </Text>
        )}
      </Box>,
    );
    index++;
  }

  // Handle unclosed code block at end of input
  if (inCodeBlock && codeBlockContent.length > 0) {
    const code = codeBlockContent.join("\n");
    contentBlocks.push(
      <Box key="unclosed-code" paddingLeft={2}>
        <Text color={colors.code.inline} backgroundColor={backgroundColor}>
          {code}
          {backgroundColor ? "  " : null}
        </Text>
      </Box>,
    );
  }

  return <Box flexDirection="column">{contentBlocks}</Box>;
};
