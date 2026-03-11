import type { ElementContent, RootContent } from "hast";
import { Box } from "ink";
import { common, createLowlight } from "lowlight";
import { memo } from "react";
import { colors } from "./colors";
import { Text } from "./Text";

const lowlight = createLowlight(common);
const BASH_LANGUAGE = "bash";
const FIRST_LINE_PREFIX = "$ ";

type Props = {
  command: string;
  showPrompt?: boolean;
  prefix?: string;
  suffix?: string;
};

type ShellSyntaxPalette = typeof colors.shellSyntax;

/** Styled text span with a resolved color. */
type StyledSpan = { text: string; color: string };

function colorForClassName(
  className: string,
  palette: ShellSyntaxPalette,
): string {
  if (className === "hljs-comment") return palette.comment;
  if (className === "hljs-keyword") return palette.keyword;
  if (className === "hljs-string" || className === "hljs-regexp") {
    return palette.string;
  }
  if (className === "hljs-number") return palette.number;
  if (className === "hljs-literal") return palette.literal;
  if (
    className === "hljs-built_in" ||
    className === "hljs-builtin-name" ||
    className === "hljs-type"
  ) {
    return palette.builtIn;
  }
  if (
    className === "hljs-variable" ||
    className === "hljs-template-variable" ||
    className === "hljs-params"
  ) {
    return palette.variable;
  }
  if (className === "hljs-title" || className === "hljs-function") {
    return palette.title;
  }
  if (className === "hljs-attr" || className === "hljs-attribute") {
    return palette.attr;
  }
  if (className === "hljs-meta") return palette.meta;
  if (
    className === "hljs-operator" ||
    className === "hljs-punctuation" ||
    className === "hljs-symbol"
  ) {
    return palette.operator;
  }
  if (className === "hljs-subst") return palette.substitution;
  return palette.text;
}

/**
 * Walk the HAST tree depth-first, collecting flat StyledSpan entries.
 * Newlines within text nodes are preserved so callers can split into lines.
 */
function collectSpans(
  node: RootContent | ElementContent,
  palette: ShellSyntaxPalette,
  spans: StyledSpan[],
  inheritedColor?: string,
): void {
  if (node.type === "text") {
    spans.push({ text: node.value, color: inheritedColor ?? palette.text });
    return;
  }

  if (node.type === "element") {
    const nodeClasses =
      (node.properties?.className as string[] | undefined) ?? [];
    const highlightClass = [...nodeClasses]
      .reverse()
      .find((name) => name.startsWith("hljs-"));
    const nodeColor = highlightClass
      ? colorForClassName(highlightClass, palette)
      : inheritedColor;

    for (const child of node.children) {
      collectSpans(child, palette, spans, nodeColor);
    }
  }
}

/**
 * Highlight the full command at once (preserves heredoc/multi-line parser
 * state), then split the flat span list at newline boundaries into per-line
 * arrays.
 */
function highlightCommand(
  command: string,
  palette: ShellSyntaxPalette,
): StyledSpan[][] {
  let spans: StyledSpan[];
  try {
    const root = lowlight.highlight(BASH_LANGUAGE, command);
    spans = [];
    for (const child of root.children) {
      collectSpans(child, palette, spans);
    }
  } catch {
    // Fallback: plain text, split by newlines.
    return command
      .split("\n")
      .map((line) => [{ text: line, color: palette.text }]);
  }

  // Split spans at newline characters into separate lines.
  const lines: StyledSpan[][] = [[]];
  for (const span of spans) {
    const parts = span.text.split("\n");
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) {
        lines.push([]);
      }
      const part = parts[i];
      if (part && part.length > 0) {
        const currentLine = lines[lines.length - 1];
        currentLine?.push({ text: part, color: span.color });
      }
    }
  }
  return lines;
}

export const SyntaxHighlightedCommand = memo(
  ({ command, showPrompt = true, prefix, suffix }: Props) => {
    const palette = colors.shellSyntax;
    const lines = highlightCommand(command, palette);

    return (
      <Box flexDirection="column">
        {lines.map((spans, lineIdx) => {
          const lineKey = spans.map((s) => s.text).join("");
          return (
            <Box key={`${lineIdx}:${lineKey}`}>
              {showPrompt ? (
                <Text color={palette.prompt}>
                  {lineIdx === 0 ? FIRST_LINE_PREFIX : "  "}
                </Text>
              ) : null}
              <Text color={palette.text}>
                {lineIdx === 0 && prefix ? prefix : null}
                {spans.map((span) => (
                  <Text key={`${span.color}:${span.text}`} color={span.color}>
                    {span.text}
                  </Text>
                ))}
                {lineIdx === lines.length - 1 && suffix ? suffix : null}
              </Text>
            </Box>
          );
        })}
      </Box>
    );
  },
);

SyntaxHighlightedCommand.displayName = "SyntaxHighlightedCommand";
