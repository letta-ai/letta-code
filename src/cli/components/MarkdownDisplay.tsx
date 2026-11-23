import { Box, Transform } from "ink";
import type React from "react";
import stringWidth from "string-width";
import { colors, hexToBgAnsi } from "./colors.js";
import { InlineMarkdown } from "./InlineMarkdownRenderer.js";
import { MarkdownTable } from "./MarkdownTable.js";
import {
  highlightCode,
  languageFromPath,
  type StyledSpan,
} from "./SyntaxHighlightedCommand.js";
import { Text } from "./Text";

interface MarkdownDisplayProps {
  text: string;
  dimColor?: boolean;
  hangingIndent?: number;
  backgroundColor?: string;
  contentWidth?: number;
}

const headerRegex = /^(#{1,6})\s+(.*)$/;
const codeBlockOpenRegex = /^ *(`{3,}|~{3,}) *([^\s`~]*)?.*$/;
const codeBlockCloseRegex = /^ *(`{3,}|~{3,}) *$/;
const listItemRegex = /^(\s*)([*\-+]|\d+\.)\s+(.*)$/;
const blockquoteRegex = /^>\s*(.*)$/;
const hrRegex = /^[-*_]{3,}$/;
const tableRowRegex = /^\|(.+)\|$/;
const tableSeparatorRegex = /^\|[\s:]*[-]+[\s:]*(\|[\s:]*[-]+[\s:]*)+\|$/;

const headerStyles: Record<
  number,
  { bold?: boolean; italic?: boolean; color?: string }
> = {
  1: { bold: true, color: colors.heading.primary },
  2: { bold: true, color: colors.heading.secondary },
  3: { bold: true },
};
const defaultHeaderStyle = { italic: true };

export const MarkdownDisplay: React.FC<MarkdownDisplayProps> = ({
  text,
  dimColor,
  hangingIndent = 0,
  backgroundColor,
  contentWidth,
}) => {
  if (!text) return null;

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

  let inCodeBlock = false;
  let codeBlockContent: string[] = [];
  let codeBlockLanguage: string | undefined;
  let codeBlockFence = "";

  const resolveFenceLanguage = (rawLanguage: string | undefined) => {
    if (!rawLanguage) return undefined;
    const normalized = rawLanguage.trim().toLowerCase();
    if (!normalized) return undefined;
    return languageFromPath(`code.${normalized}`) ?? normalized;
  };

  const renderCodeLine = (
    spans: StyledSpan[] | undefined,
    fallbackText: string,
    key: string,
  ) => (
    <Text
      key={key}
      color={spans ? undefined : colors.shellSyntax.string}
      backgroundColor={backgroundColor}
      dimColor={dimColor}
    >
      {spans
        ? spans.length > 0
          ? spans.map((span, spanIdx) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: spans are static render chunks
              <Text key={spanIdx} color={span.color}>
                {span.text}
              </Text>
            ))
          : " "
        : fallbackText || " "}
      {backgroundColor ? "  " : null}
    </Text>
  );

  const renderCodeBlock = (
    code: string,
    language: string | undefined,
    key: string,
  ) => {
    const highlightedLines = language
      ? highlightCode(code, language)
      : undefined;
    const fallbackLines = code.split("\n");
    const lineCount = Math.max(
      highlightedLines?.length ?? 0,
      fallbackLines.length,
      1,
    );

    return (
      <Box key={key} flexDirection="column">
        {Array.from({ length: lineCount }, (_, lineIdx) =>
          renderCodeLine(
            highlightedLines?.[lineIdx],
            fallbackLines[lineIdx] ?? "",
            `${key}-code-${lineIdx}`,
          ),
        )}
      </Box>
    );
  };

  let index = 0;
  while (index < lines.length) {
    const line = lines[index] as string;
    const key = `line-${index}`;

    if (inCodeBlock) {
      const codeBlockCloseMatch = line.match(codeBlockCloseRegex);
      const fence = codeBlockCloseMatch?.[1] ?? "";
      if (
        codeBlockCloseMatch &&
        fence.startsWith(codeBlockFence[0] ?? "") &&
        fence.length >= codeBlockFence.length
      ) {
        inCodeBlock = false;
        const code = codeBlockContent.join("\n");
        contentBlocks.push(renderCodeBlock(code, codeBlockLanguage, key));
        codeBlockContent = [];
        codeBlockLanguage = undefined;
        codeBlockFence = "";
        index++;
        continue;
      }

      codeBlockContent.push(line);
      index++;
      continue;
    }

    const codeBlockOpenMatch = line.match(codeBlockOpenRegex);
    if (codeBlockOpenMatch) {
      inCodeBlock = true;
      codeBlockContent = [];
      codeBlockFence = codeBlockOpenMatch[1] ?? "";
      codeBlockLanguage = resolveFenceLanguage(codeBlockOpenMatch[2]);
      index++;
      continue;
    }

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

    const nextLine = lines[index + 1];
    if (
      tableRowRegex.test(line) &&
      nextLine &&
      tableSeparatorRegex.test(nextLine)
    ) {
      const tableLines: string[] = [line];
      let tableIdx = index + 1;
      while (tableIdx < lines.length) {
        const tableLine = lines[tableIdx];
        if (!tableLine || !tableRowRegex.test(tableLine)) break;
        tableLines.push(tableLine);
        tableIdx++;
      }
      if (tableLines.length >= 2) {
        contentBlocks.push(
          <MarkdownTable
            key={`table-${index}`}
            tableLines={tableLines}
            contentWidth={contentWidth}
            dimColor={dimColor}
            backgroundColor={backgroundColor}
          />,
        );
        index = tableIdx;
        continue;
      }
    }

    if (line.trim() === "") {
      if (backgroundColor) {
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

  if (inCodeBlock && codeBlockContent.length > 0) {
    const code = codeBlockContent.join("\n");
    contentBlocks.push(
      renderCodeBlock(code, codeBlockLanguage, "unclosed-code"),
    );
  }

  return <Box flexDirection="column">{contentBlocks}</Box>;
};
