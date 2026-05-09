import { memo } from "react";
import stringWidth from "string-width";
import {
  SYSTEM_ALERT_CLOSE,
  SYSTEM_ALERT_OPEN,
  SYSTEM_REMINDER_CLOSE,
  SYSTEM_REMINDER_OPEN,
} from "../../constants";
import { extractTaskNotificationsForDisplay } from "../helpers/taskNotifications";
import { useTerminalWidth } from "../hooks/useTerminalWidth";
import { colors, hexToBgAnsi, hexToFgAnsi } from "./colors";
import { Text } from "./Text";

type UserLine = {
  kind: "user";
  id: string;
  text: string;
};

/**
 * Word-wrap plain text to a given visible width.
 * Returns an array of lines, each at most `width` visible characters wide.
 */
function wordWrap(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    if (current === "") {
      current = word;
    } else {
      const candidate = `${current} ${word}`;
      if (stringWidth(candidate) <= width) {
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

const ERASE_TO_END_OF_LINE = "\x1b[K";

function renderHighlightedBlankLine(colorAnsi: string): string {
  return `${colorAnsi}${ERASE_TO_END_OF_LINE}\x1b[0m`;
}

/**
 * Render a block of text with a prompt prefix (first line) and matching-width
 * continuation spaces on subsequent lines.
 * If highlighted, applies background and foreground colors. Otherwise plain text.
 */
export function renderBlock(
  text: string,
  contentWidth: number,
  highlighted: boolean,
  colorAnsi: string, // combined bg + fg ANSI codes
  promptPrefix: string,
  continuationPrefix: string,
): string[] {
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

    if (!highlighted) {
      return prefix + ol;
    }

    // Re-apply colorAnsi after the prompt character on the first line because
    // the prompt string may contain an ANSI reset (\x1b[0m) that clears
    // the background highlight. Insert before the trailing space so it's
    // also highlighted.
    const content =
      i === 0
        ? `${promptPrefix.slice(0, -1)}${colorAnsi} ${ol}`
        : `${prefix}${ol}`;
    // Fill to the terminal edge without printing trailing spaces. Padding with
    // spaces can leave the final cell unpainted after Ink/terminal wrapping.
    return `${colorAnsi}${content}${colorAnsi}${ERASE_TO_END_OF_LINE}\x1b[0m`;
  });

  if (!highlighted) {
    return renderedLines;
  }

  const blankLine = renderHighlightedBlankLine(colorAnsi);
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
    const columns = useTerminalWidth();
    const promptPrefix = `${prompt || ">"} `;
    const prefixWidth = stringWidth(promptPrefix);
    const continuationPrefix = " ".repeat(prefixWidth);
    const contentWidth = Math.max(1, columns - prefixWidth);
    const cleanedText = extractTaskNotificationsForDisplay(
      line.text,
    ).cleanedText;
    const displayText = cleanedText.trim();
    if (!displayText) {
      return null;
    }

    // Build combined ANSI code for background + optional foreground
    const { background, text: textColor } = colors.userMessage;
    const bgAnsi = hexToBgAnsi(background);
    const fgAnsi = textColor ? hexToFgAnsi(textColor) : "";
    const colorAnsi = bgAnsi + fgAnsi;

    // Split into system-reminder blocks and user content blocks
    const blocks = splitSystemReminderBlocks(displayText);

    const allLines: string[] = [];

    for (const block of blocks) {
      if (!block.text.trim()) continue;
      if (allLines.length > 0) {
        allLines.push("");
      }
      const blockLines = renderBlock(
        block.text,
        contentWidth,
        !block.isSystemReminder,
        colorAnsi,
        promptPrefix,
        continuationPrefix,
      );
      allLines.push(...blockLines);
    }

    return <Text>{allLines.join("\n")}</Text>;
  },
);

UserMessage.displayName = "UserMessage";
