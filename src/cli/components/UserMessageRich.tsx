import { Text } from "ink";
import { memo } from "react";
import stringWidth from "string-width";
import { useTerminalWidth } from "../hooks/useTerminalWidth";
import { colors, hexToBgAnsi, hexToFgAnsi } from "./colors";

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

/** Right-padding (in characters) added after content on compact (single-line) messages. */
const COMPACT_PAD = 1;

/**
 * Split text into system-reminder blocks and user content blocks.
 * System-reminder blocks are identified by <system-reminder>...</system-reminder> tags.
 * Returns array of { text, isSystemReminder } objects in order.
 */
function splitSystemReminderBlocks(
  text: string,
): Array<{ text: string; isSystemReminder: boolean }> {
  const blocks: Array<{ text: string; isSystemReminder: boolean }> = [];
  const tagOpen = "<system-reminder>";
  const tagClose = "</system-reminder>";

  let remaining = text;

  while (remaining.length > 0) {
    const openIdx = remaining.indexOf(tagOpen);

    if (openIdx === -1) {
      // No more system-reminder tags, rest is user content
      if (remaining.trim()) {
        blocks.push({ text: remaining.trim(), isSystemReminder: false });
      }
      break;
    }

    // Content before the tag is user content
    if (openIdx > 0) {
      const before = remaining.slice(0, openIdx).trim();
      if (before) {
        blocks.push({ text: before, isSystemReminder: false });
      }
    }

    // Find the closing tag
    const closeIdx = remaining.indexOf(tagClose, openIdx);
    if (closeIdx === -1) {
      // Malformed - no closing tag, treat rest as system-reminder
      blocks.push({
        text: remaining.slice(openIdx).trim(),
        isSystemReminder: true,
      });
      break;
    }

    // Extract the full system-reminder block (including tags)
    const sysBlock = remaining.slice(openIdx, closeIdx + tagClose.length);
    blocks.push({ text: sysBlock, isSystemReminder: true });

    remaining = remaining.slice(closeIdx + tagClose.length);
  }

  return blocks;
}

/**
 * Render a block of text with "> " prefix (first line) and "  " continuation.
 * If highlighted, applies background and foreground colors. Otherwise plain text.
 */
function renderBlock(
  text: string,
  contentWidth: number,
  columns: number,
  highlighted: boolean,
  colorAnsi: string, // combined bg + fg ANSI codes
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

  const isSingleLine = outputLines.length === 1;

  return outputLines.map((ol, i) => {
    const prefix = i === 0 ? "> " : "  ";
    const content = prefix + ol;

    if (!highlighted) {
      return content;
    }

    const visWidth = stringWidth(content);
    if (isSingleLine) {
      return `${colorAnsi}${content}${" ".repeat(COMPACT_PAD)}\x1b[0m`;
    }
    const pad = Math.max(0, columns - visWidth);
    return `${colorAnsi}${content}${" ".repeat(pad)}\x1b[0m`;
  });
}

/**
 * UserMessageRich - Rich formatting for user messages with background highlight
 *
 * Renders user messages as pre-formatted text with ANSI background codes:
 * - "> " prompt prefix on first line, "  " continuation on subsequent lines
 * - Single-line messages: compact highlight (content + small padding)
 * - Multi-line messages: full-width highlight box extending to terminal edge
 * - Word wrapping respects the 2-char prefix width
 * - System-reminder parts are shown plain (no highlight), user parts highlighted
 */
export const UserMessage = memo(({ line }: { line: UserLine }) => {
  const columns = useTerminalWidth();
  const contentWidth = Math.max(1, columns - 2);

  // Build combined ANSI code for background + optional foreground
  const { background, text: textColor } = colors.userMessage;
  const bgAnsi = hexToBgAnsi(background);
  const fgAnsi = textColor ? hexToFgAnsi(textColor) : "";
  const colorAnsi = bgAnsi + fgAnsi;

  // Split into system-reminder blocks and user content blocks
  const blocks = splitSystemReminderBlocks(line.text);

  const allLines: string[] = [];

  for (const block of blocks) {
    if (!block.text.trim()) continue;

    // Add blank line between blocks (not before first)
    if (allLines.length > 0) {
      allLines.push("");
    }

    const blockLines = renderBlock(
      block.text,
      contentWidth,
      columns,
      !block.isSystemReminder, // highlight user content, not system-reminder
      colorAnsi,
    );
    allLines.push(...blockLines);
  }

  return <Text>{allLines.join("\n")}</Text>;
});

UserMessage.displayName = "UserMessage";
