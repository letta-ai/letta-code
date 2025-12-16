import { Box, Text } from "ink";
import type React from "react";
import { colors } from "./colors.js";
import { InlineMarkdown } from "./InlineMarkdownRenderer.js";

interface MarkdownDisplayProps {
  text: string;
  dimColor?: boolean;
  hangingIndent?: number; // indent for wrapped lines within a paragraph
}

/**
 * Renders full markdown content using pure Ink components.
 * Based on Gemini CLI's approach - NO ANSI codes, NO marked-terminal!
 */
import { Transform } from "ink";

export const MarkdownDisplay: React.FC<MarkdownDisplayProps> = ({
  text,
  dimColor,
  hangingIndent = 0,
}) => {
  if (!text) return null;

  const lines = text.split("\n");
  const contentBlocks: React.ReactNode[] = [];

  // Regex patterns for markdown elements
  const headerRegex = /^(#{1,6})\s+(.*)$/;
  const codeBlockRegex = /^```(\w*)?$/;
  const listItemRegex = /^(\s*)([*\-+]|\d+\.)\s+(.*)$/;
  const blockquoteRegex = /^>\s*(.*)$/;
  const hrRegex = /^[-*_]{3,}$/;
  const tableRowRegex = /^\|(.+)\|$/;
  const tableSeparatorRegex = /^\|[\s:]*[-]+[\s:]*(\|[\s:]*[-]+[\s:]*)+\|$/;

  let inCodeBlock = false;
  let codeBlockContent: string[] = [];
  let _codeBlockLang = "";

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

    const totalWidth = colWidths.reduce((sum, w) => sum + w + 3, 0) + 1; // +3 for " │ " separators

    return (
      <Box key={`table-${startIndex}`} flexDirection="column" marginY={0}>
        {/* Header row */}
        <Box flexDirection="row">
          <Text dimColor={dimColor}>│</Text>
          {headerRow.map((cell, idx) => (
            <Box key={`h-${idx}`} flexDirection="row">
              <Text bold dimColor={dimColor}>
                {" "}
                {cell.padEnd(colWidths[idx] ?? 3)}
              </Text>
              <Text dimColor={dimColor}> │</Text>
            </Box>
          ))}
        </Box>
        {/* Separator */}
        <Box flexDirection="row">
          <Text dimColor={dimColor}>├</Text>
          {colWidths.map((width, idx) => (
            <Box key={`s-${idx}`} flexDirection="row">
              <Text dimColor={dimColor}>{"─".repeat(width + 2)}</Text>
              <Text dimColor={dimColor}>
                {idx < colWidths.length - 1 ? "┼" : "┤"}
              </Text>
            </Box>
          ))}
        </Box>
        {/* Body rows */}
        {bodyRows.map((row, rowIdx) => (
          <Box key={`r-${rowIdx}`} flexDirection="row">
            <Text dimColor={dimColor}>│</Text>
            {row.map((cell, colIdx) => (
              <Box key={`c-${colIdx}`} flexDirection="row">
                <Text dimColor={dimColor}>
                  {" "}
                  {(cell || "").padEnd(colWidths[colIdx] || 3)}
                </Text>
                <Text dimColor={dimColor}> │</Text>
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

    // Handle code blocks
    if (line.match(codeBlockRegex)) {
      if (!inCodeBlock) {
        // Start of code block
        const match = line.match(codeBlockRegex);
        _codeBlockLang = match?.[1] || "";
        inCodeBlock = true;
        codeBlockContent = [];
      } else {
        // End of code block
        inCodeBlock = false;

        // Render the code block
        const code = codeBlockContent.join("\n");

        // For now, use simple colored text for code blocks
        // TODO: Could parse cli-highlight output and convert ANSI to Ink components
        // but for MVP, just use a nice color like Gemini does
        contentBlocks.push(
          <Box key={key} paddingLeft={2}>
            <Text color={colors.code.inline}>{code}</Text>
          </Box>,
        );

        codeBlockContent = [];
        _codeBlockLang = "";
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

      // Different styling for different header levels
      let headerElement: React.ReactNode;
      if (level === 1) {
        headerElement = (
          <Text bold color={colors.heading.primary}>
            <InlineMarkdown text={content} dimColor={dimColor} />
          </Text>
        );
      } else if (level === 2) {
        headerElement = (
          <Text bold color={colors.heading.secondary}>
            <InlineMarkdown text={content} dimColor={dimColor} />
          </Text>
        );
      } else if (level === 3) {
        headerElement = (
          <Text bold>
            <InlineMarkdown text={content} dimColor={dimColor} />
          </Text>
        );
      } else {
        headerElement = (
          <Text italic>
            <InlineMarkdown text={content} dimColor={dimColor} />
          </Text>
        );
      }

      contentBlocks.push(<Box key={key}>{headerElement}</Box>);
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
            <Text dimColor={dimColor}>{bullet}</Text>
          </Box>
          <Box flexGrow={1}>
            <Text wrap="wrap" dimColor={dimColor}>
              <InlineMarkdown text={content} dimColor={dimColor} />
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
          <Text dimColor>│ </Text>
          <Text wrap="wrap" dimColor={dimColor}>
            <InlineMarkdown text={blockquoteMatch[1]} dimColor={dimColor} />
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
          <Text dimColor>───────────────────────────────</Text>
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
      contentBlocks.push(<Box key={key} height={1} />);
      index++;
      continue;
    }

    // Regular paragraph text with optional hanging indent for wrapped lines
    contentBlocks.push(
      <Box key={key}>
        {hangingIndent > 0 ? (
          <Transform
            transform={(ln, i) =>
              i === 0 ? ln : " ".repeat(hangingIndent) + ln
            }
          >
            <Text wrap="wrap" dimColor={dimColor}>
              <InlineMarkdown text={line} dimColor={dimColor} />
            </Text>
          </Transform>
        ) : (
          <Text wrap="wrap" dimColor={dimColor}>
            <InlineMarkdown text={line} dimColor={dimColor} />
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
        <Text color={colors.code.inline}>{code}</Text>
      </Box>,
    );
  }

  return <Box flexDirection="column">{contentBlocks}</Box>;
};
