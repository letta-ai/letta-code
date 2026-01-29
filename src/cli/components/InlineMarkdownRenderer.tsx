import { Text } from "ink";
import type React from "react";
import { colors } from "./colors.js";

interface InlineMarkdownProps {
  text: string;
  dimColor?: boolean;
  backgroundColor?: string;
}

/**
 * Renders inline markdown (bold, italic, code, etc.) using pure Ink components.
 * Based on Gemini CLI's approach - NO ANSI codes!
 * Note: dimColor should be handled by parent Text component for proper wrapping
 */
export const InlineMarkdown: React.FC<InlineMarkdownProps> = ({
  text,
  dimColor,
  backgroundColor,
}) => {
  // Early return for plain text without markdown (treat underscores as plain text)
  if (!/[*~`[]/.test(text)) {
    return <>{text}</>;
  }

  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;

  // Regex to match inline markdown patterns (underscore italics disabled)
  // Matches: **bold**, *italic*, ~~strikethrough~~, `code`, [link](url)
  const inlineRegex =
    /(\*\*[^*]+\*\*|\*[^*]+\*|~~[^~]+~~|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  let match: RegExpExecArray | null = inlineRegex.exec(text);

  while (match !== null) {
    // Add text before the match
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }

    const fullMatch = match[0];
    const key = `m-${match.index}`;

    // Handle different markdown patterns
    if (
      fullMatch.startsWith("**") &&
      fullMatch.endsWith("**") &&
      fullMatch.length > 4
    ) {
      // Bold
      nodes.push(
        <Text
          key={key}
          bold
          dimColor={dimColor}
          backgroundColor={backgroundColor}
        >
          {fullMatch.slice(2, -2)}
        </Text>,
      );
    } else if (
      fullMatch.length > 2 &&
      fullMatch.startsWith("*") &&
      fullMatch.endsWith("*")
    ) {
      // Italic
      nodes.push(
        <Text
          key={key}
          italic
          dimColor={dimColor}
          backgroundColor={backgroundColor}
        >
          {fullMatch.slice(1, -1)}
        </Text>,
      );
    } else if (
      fullMatch.startsWith("~~") &&
      fullMatch.endsWith("~~") &&
      fullMatch.length > 4
    ) {
      // Strikethrough
      nodes.push(
        <Text
          key={key}
          strikethrough
          dimColor={dimColor}
          backgroundColor={backgroundColor}
        >
          {fullMatch.slice(2, -2)}
        </Text>,
      );
    } else if (fullMatch.startsWith("`") && fullMatch.endsWith("`")) {
      // Inline code
      nodes.push(
        <Text
          key={key}
          color={colors.link.text}
          backgroundColor={backgroundColor}
        >
          {fullMatch.slice(1, -1)}
        </Text>,
      );
    } else if (
      fullMatch.startsWith("[") &&
      fullMatch.includes("](") &&
      fullMatch.endsWith(")")
    ) {
      // Link [text](url)
      const linkMatch = fullMatch.match(/\[(.*?)\]\((.*?)\)/);
      if (linkMatch) {
        const linkText = linkMatch[1];
        const url = linkMatch[2];
        nodes.push(
          <Text key={key} backgroundColor={backgroundColor}>
            {linkText}
            <Text color={colors.link.url} backgroundColor={backgroundColor}>
              {" "}
              ({url})
            </Text>
          </Text>,
        );
      } else {
        // Fallback if link parsing fails
        nodes.push(fullMatch);
      }
    } else {
      // Unknown pattern, render as-is
      nodes.push(fullMatch);
    }

    lastIndex = inlineRegex.lastIndex;
    match = inlineRegex.exec(text);
  }

  // Add remaining text after last match
  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return <>{nodes}</>;
};

// Test helper: expose the tokenizer logic for simple unit validation without rendering.
// This mirrors the logic above; keep it in sync with InlineMarkdown for tests.
