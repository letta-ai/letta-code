import { Box } from "ink";
import { memo } from "react";
import { CLI_GLYPHS } from "@/cli/helpers/glyphs";
import { useTerminalWidth } from "@/cli/hooks/use-terminal-width";
import {
  SYSTEM_ALERT_CLOSE,
  SYSTEM_ALERT_OPEN,
  SYSTEM_REMINDER_CLOSE,
  SYSTEM_REMINDER_OPEN,
} from "@/constants";
import { extractTaskNotificationsForDisplay } from "@/utils/task-notifications";
import { colors } from "./colors";
import { Text } from "./Text";

type UserLine = {
  kind: "user";
  id: string;
  text: string;
};

type RenderedBlockLine = {
  text: string;
  highlighted: boolean;
};

function getCurrentStdoutColumns(): number | null {
  if (typeof process === "undefined") return null;
  const columns = (process.stdout as NodeJS.WriteStream | undefined)?.columns;
  return typeof columns === "number" && columns > 0 ? columns : null;
}

function isInkFullWidthCodePoint(codePoint: number): boolean {
  // Match Ink's @alcalzone/ansi-tokenize/is-fullwidth-code-point width
  // semantics. In particular, U+26A0 WARNING SIGN is narrow here even though
  // string-width reports it as wide, and Ink's output buffer follows this path.
  return (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (0x2e80 <= codePoint && codePoint <= 0x3247 && codePoint !== 0x303f) ||
      (0x3250 <= codePoint && codePoint <= 0x4dbf) ||
      (0x4e00 <= codePoint && codePoint <= 0xa4c6) ||
      (0xa960 <= codePoint && codePoint <= 0xa97c) ||
      (0xac00 <= codePoint && codePoint <= 0xd7a3) ||
      (0xf900 <= codePoint && codePoint <= 0xfaff) ||
      (0xfe10 <= codePoint && codePoint <= 0xfe19) ||
      (0xfe30 <= codePoint && codePoint <= 0xfe6b) ||
      (0xff01 <= codePoint && codePoint <= 0xff60) ||
      (0xffe0 <= codePoint && codePoint <= 0xffe6) ||
      (0x1b000 <= codePoint && codePoint <= 0x1b001) ||
      (0x1f200 <= codePoint && codePoint <= 0x1f251) ||
      (0x20000 <= codePoint && codePoint <= 0x3fffd))
  );
}

function inkStringWidth(text: string): number {
  let width = 0;
  for (let index = 0; index < text.length; ) {
    const codePoint = text.codePointAt(index);
    if (codePoint === undefined) break;
    const character = String.fromCodePoint(codePoint);
    width += isInkFullWidthCodePoint(codePoint) || character.length > 1 ? 2 : 1;
    index += character.length;
  }
  return width;
}

/**
 * Word-wrap plain text to a given visible width.
 * Returns an array of lines, each at most `width` visible characters wide.
 */
function wordWrap(text: string, width: number): string[] {
  if (width <= 0) return [text];

  const hardWrap = (value: string): string[] => {
    const chunks: string[] = [];
    let current = "";
    let currentWidth = 0;

    for (let index = 0; index < value.length; ) {
      const codePoint = value.codePointAt(index);
      if (codePoint === undefined) break;
      const character = String.fromCodePoint(codePoint);
      const characterWidth = inkStringWidth(character);

      if (current && currentWidth + characterWidth > width) {
        chunks.push(current);
        current = "";
        currentWidth = 0;
      }

      current += character;
      currentWidth += characterWidth;
      index += character.length;
    }

    if (current) {
      chunks.push(current);
    }
    return chunks.length > 0 ? chunks : [""];
  };

  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    if (inkStringWidth(word) > width) {
      if (current !== "") {
        lines.push(current);
        current = "";
      }
      lines.push(...hardWrap(word));
      continue;
    }

    if (current === "") {
      current = word;
    } else {
      const candidate = `${current} ${word}`;
      if (inkStringWidth(candidate) <= width) {
        current = candidate;
      } else {
        lines.push(current);
        current = word;
      }
    }
  }
  if (current !== "") {
    lines.push(current);
  }
  return lines.length > 0 ? lines : [""];
}

/**
 * Split text into system-reminder blocks and user content blocks.
 * System-reminder blocks are identified by <system-reminder>...</system-reminder> tags.
 * Returns array of { text, isSystemReminder } objects in order.
 */
export function splitSystemReminderBlocks(
  text: string,
): Array<{ text: string; isSystemReminder: boolean }> {
  const blocks: Array<{ text: string; isSystemReminder: boolean }> = [];
  const tags = [
    { open: SYSTEM_REMINDER_OPEN, close: SYSTEM_REMINDER_CLOSE },
    { open: SYSTEM_ALERT_OPEN, close: SYSTEM_ALERT_CLOSE }, // legacy
  ];

  let remaining = text;

  while (remaining.length > 0) {
    const nextTag = tags
      .map((tag) => ({ ...tag, idx: remaining.indexOf(tag.open) }))
      .filter((tag) => tag.idx >= 0)
      .sort((a, b) => a.idx - b.idx)[0];

    if (!nextTag) {
      // No more system-reminder tags, rest is user content
      if (remaining.trim()) {
        blocks.push({ text: remaining.trim(), isSystemReminder: false });
      }
      break;
    }

    // Find the closing tag
    const closeIdx = remaining.indexOf(nextTag.close, nextTag.idx);
    if (closeIdx === -1) {
      // Malformed/incomplete tag - treat the whole remainder as literal user text.
      const literal = remaining.trim();
      if (literal) {
        blocks.push({ text: literal, isSystemReminder: false });
      }
      break;
    }

    // Content before the tag is user content
    if (nextTag.idx > 0) {
      const before = remaining.slice(0, nextTag.idx).trim();
      if (before) {
        blocks.push({ text: before, isSystemReminder: false });
      }
    }

    // Extract the full system-reminder block (including tags)
    const sysBlock = remaining.slice(
      nextTag.idx,
      closeIdx + nextTag.close.length,
    );
    blocks.push({ text: sysBlock, isSystemReminder: true });

    remaining = remaining.slice(closeIdx + nextTag.close.length);
  }

  return blocks;
}

function padToColumns(text: string, columns: number): string {
  const pad = Math.max(0, columns - inkStringWidth(text));
  return `${text}${" ".repeat(pad)}`;
}

/**
 * Render a block of text with a prompt prefix (first line) and matching-width
 * continuation spaces on subsequent lines.
 * If highlighted, applies background and foreground colors. Otherwise plain text.
 */
export function renderBlock(
  text: string,
  contentWidth: number,
  columns: number,
  highlighted: boolean,
  promptPrefix: string,
  continuationPrefix: string,
): RenderedBlockLine[] {
  const inputLines = text.split("\n");
  const outputLines: string[] = [];

  for (const inputLine of inputLines) {
    if (inputLine.trim() === "") {
      outputLines.push("");
      continue;
    }
    const wrappedLines = wordWrap(inputLine, contentWidth);
    for (const wl of wrappedLines) {
      outputLines.push(wl);
    }
  }

  if (outputLines.length === 0) return [];

  const renderedLines = outputLines.map((ol, i) => {
    const prefix = i === 0 ? promptPrefix : continuationPrefix;
    const content = `${prefix}${ol}`;

    if (!highlighted) {
      return { text: content, highlighted: false };
    }

    return { text: padToColumns(content, columns), highlighted: true };
  });

  if (!highlighted) {
    return renderedLines;
  }

  const blankLine = {
    text: " ".repeat(Math.max(0, columns)),
    highlighted: true,
  };
  return [blankLine, ...renderedLines, blankLine];
}

/**
 * UserMessageRich - Rich formatting for user messages with background highlight
 *
 * Renders user messages as pre-formatted text with ANSI background codes:
 * - Custom prompt prefix on first line, matching-width spaces on subsequent lines
 * - User content blocks: full-width highlight box extending to terminal edge
 *   with one highlighted blank row above and below
 * - Word wrapping respects the prompt prefix width
 * - System-reminder parts are shown plain (no highlight), user parts highlighted
 */
export const UserMessage = memo(
  ({ line, prompt }: { line: UserLine; prompt?: string }) => {
    const trackedColumns = useTerminalWidth();
    const columns = getCurrentStdoutColumns() ?? trackedColumns;
    const promptPrefix = `${prompt || CLI_GLYPHS.prompt} `;
    const prefixWidth = inkStringWidth(promptPrefix);
    const continuationPrefix = " ".repeat(prefixWidth);
    const contentWidth = Math.max(1, columns - prefixWidth);
    const cleanedText = extractTaskNotificationsForDisplay(
      line.text,
    ).cleanedText;
    const displayText = cleanedText.trim();
    if (!displayText) {
      return null;
    }

    const { background, text: textColor } = colors.userMessage;

    // Split into system-reminder blocks and user content blocks
    const blocks = splitSystemReminderBlocks(displayText);

    const allLines: RenderedBlockLine[] = [];

    for (const block of blocks) {
      if (!block.text.trim()) continue;
      if (allLines.length > 0) {
        allLines.push({ text: "", highlighted: false });
      }
      const blockLines = renderBlock(
        block.text,
        contentWidth,
        columns,
        !block.isSystemReminder,
        promptPrefix,
        continuationPrefix,
      );
      allLines.push(...blockLines);
    }

    return (
      <Box flexDirection="column">
        {allLines.map((line, index) => (
          <Text
            // biome-ignore lint/suspicious/noArrayIndexKey: rendered rows are static
            key={index}
            backgroundColor={line.highlighted ? background : undefined}
            color={line.highlighted ? textColor : undefined}
            wrap={line.highlighted ? "end" : "wrap"}
          >
            {line.text}
          </Text>
        ))}
      </Box>
    );
  },
);

UserMessage.displayName = "UserMessage";
