// Text layout helpers for the composer input: visual-line wrapping and
// display-string truncation. A visual line ends at a newline character
// (hard break) or when it reaches the terminal width (soft wrap).

/**
 * Represents a visual line segment in the text.
 * A visual line ends at either a newline character or when it reaches lineWidth.
 */
export interface VisualLine {
  start: number; // Start index in text
  end: number; // End index (exclusive, not including \n)
}

/**
 * Computes visual lines from text, accounting for both hard breaks (\n)
 * and soft wrapping at lineWidth.
 */
export function getVisualLines(text: string, lineWidth: number): VisualLine[] {
  const lines: VisualLine[] = [];
  let lineStart = 0;

  for (let i = 0; i <= text.length; i++) {
    const char = text[i];
    const lineLength = i - lineStart;

    if (char === "\n" || i === text.length) {
      // Hard break or end of text
      lines.push({ start: lineStart, end: i });
      lineStart = i + 1;
    } else if (lineLength >= lineWidth && lineWidth > 0) {
      // Soft wrap - line is full
      lines.push({ start: lineStart, end: i });
      lineStart = i;
    }
  }

  // Ensure at least one line for empty text
  if (lines.length === 0) {
    lines.push({ start: 0, end: 0 });
  }

  return lines;
}

/**
 * Finds which visual line the cursor is on and the column within that line.
 */
export function findCursorLine(
  cursorPos: number,
  visualLines: VisualLine[],
): { lineIndex: number; column: number } {
  for (let i = 0; i < visualLines.length; i++) {
    const line = visualLines[i];
    if (line && cursorPos >= line.start && cursorPos <= line.end) {
      return { lineIndex: i, column: cursorPos - line.start };
    }
  }
  // Fallback to last line
  const lastLine = visualLines[visualLines.length - 1];
  return {
    lineIndex: visualLines.length - 1,
    column: Math.max(0, cursorPos - (lastLine?.start ?? 0)),
  };
}

/** Truncate a display string to maxChars, appending "..." when truncated. */
export function truncateEnd(value: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (value.length <= maxChars) return value;
  if (maxChars <= 3) return value.slice(0, maxChars);
  return `${value.slice(0, maxChars - 3)}...`;
}
