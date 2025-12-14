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

  let inCodeBlock = false;
  let codeBlockContent: string[] = [];
  let _codeBlockLang = "";

  lines.forEach((line, index) => {
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
      return;
    }

    // If we're inside a code block, collect the content
    if (inCodeBlock) {
      codeBlockContent.push(line);
      return;
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

      contentBlocks.push(
        <Box key={key}>
          {headerElement}
        </Box>,
      );
      return;
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

      // Determine if it's ordered or unordered list
      const isOrdered = /^\d+\./.test(marker);
      const bullet = isOrdered ? `${marker} ` : "• ";
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
      return;
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
      return;
    }

    // Check for horizontal rules
    if (line.match(hrRegex)) {
      contentBlocks.push(
        <Box key={key}>
          <Text dimColor>───────────────────────────────</Text>
        </Box>,
      );
      return;
    }

    // Empty lines
    if (line.trim() === "") {
      contentBlocks.push(<Box key={key} height={1} />);
      return;
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
  });

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
