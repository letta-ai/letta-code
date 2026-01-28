import { Text } from "ink";
import { memo } from "react";
import stringWidth from "string-width";
import { useTerminalWidth } from "../hooks/useTerminalWidth";
import { colors } from "./colors";

type UserLine = {
  kind: "user";
  id: string;
  text: string;
};

/**
 * Convert a hex color (#RRGGBB) to an ANSI 24-bit background escape sequence.
 */
function hexToBgAnsi(hex: string): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `\x1b[48;2;${r};${g};${b}m`;
}

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
      const candidate = current + " " + word;
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
 * UserMessageRich - Rich formatting for user messages with full-width background highlight
 *
 * Renders user messages as pre-formatted text with ANSI background codes to ensure
 * a perfectly consistent highlighted box:
 * - "> " prompt prefix on first line, "  " continuation on subsequent lines
 * - Full-width background color fills every line to the terminal edge
 * - Word wrapping respects the 2-char prefix width
 */
export const UserMessage = memo(({ line }: { line: UserLine }) => {
  const columns = useTerminalWidth();
  const contentWidth = Math.max(1, columns - 2);
  const bg = colors.userMessage.background;
  const bgAnsi = hexToBgAnsi(bg);

  const inputLines = line.text.split("\n");
  const outputLines: string[] = [];
  let isFirstLine = true;

  for (const inputLine of inputLines) {
    if (inputLine.trim() === "") {
      // Empty line — render full-width background
      const prefix = isFirstLine ? "> " : "  ";
      const pad = Math.max(0, columns - stringWidth(prefix));
      outputLines.push(`${bgAnsi}${prefix}${" ".repeat(pad)}\x1b[0m`);
      isFirstLine = false;
      continue;
    }

    const wrappedLines = wordWrap(inputLine, contentWidth);
    for (const wl of wrappedLines) {
      const prefix = isFirstLine ? "> " : "  ";
      const content = prefix + wl;
      const visWidth = stringWidth(content);
      const pad = Math.max(0, columns - visWidth);
      outputLines.push(`${bgAnsi}${content}${" ".repeat(pad)}\x1b[0m`);
      isFirstLine = false;
    }
  }

  return <Text>{outputLines.join("\n")}</Text>;
});

UserMessage.displayName = "UserMessage";
