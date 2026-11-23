export interface VisualLine {
  start: number;
  end: number;
}

export function getVisualLines(text: string, lineWidth: number): VisualLine[] {
  const lines: VisualLine[] = [];
  let lineStart = 0;

  for (let i = 0; i <= text.length; i++) {
    const char = text[i];
    const lineLength = i - lineStart;

    if (char === "\n" || i === text.length) {
      lines.push({ start: lineStart, end: i });
      lineStart = i + 1;
    } else if (lineLength >= lineWidth && lineWidth > 0) {
      lines.push({ start: lineStart, end: i });
      lineStart = i;
    }
  }

  if (lines.length === 0) {
    lines.push({ start: 0, end: 0 });
  }

  return lines;
}

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
  const lastLine = visualLines[visualLines.length - 1];
  return {
    lineIndex: visualLines.length - 1,
    column: Math.max(0, cursorPos - (lastLine?.start ?? 0)),
  };
}

export function truncateEnd(value: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (value.length <= maxChars) return value;
  if (maxChars <= 3) return value.slice(0, maxChars);
  return `${value.slice(0, maxChars - 3)}...`;
}
