import type React from "react";
import { colors } from "./colors.js";
import { Text } from "./Text";

interface InlineMarkdownProps {
  text: string;
  dimColor?: boolean;
  backgroundColor?: string;
}

export const InlineMarkdown: React.FC<InlineMarkdownProps> = ({
  text,
  dimColor,
  backgroundColor,
}) => {
  if (!/[*~`[]/.test(text)) {
    return <>{text}</>;
  }

  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;

  const inlineRegex =
    /(\*\*[^*]+\*\*|\*[^*]+\*|~~[^~]+~~|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  let match: RegExpExecArray | null = inlineRegex.exec(text);

  while (match !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }

    const fullMatch = match[0];
    const key = `m-${match.index}`;

    if (
      fullMatch.startsWith("**") &&
      fullMatch.endsWith("**") &&
      fullMatch.length > 4
    ) {
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
        nodes.push(fullMatch);
      }
    } else {
      nodes.push(fullMatch);
    }

    lastIndex = inlineRegex.lastIndex;
    match = inlineRegex.exec(text);
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return <>{nodes}</>;
};
