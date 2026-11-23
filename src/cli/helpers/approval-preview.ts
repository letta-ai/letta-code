import stringWidth from "string-width";

export function countPreviewRows(lines: string[], width: number): number {
  const wrapWidth = Math.max(1, width);
  return lines.reduce(
    (sum, line) => sum + Math.max(1, Math.ceil(stringWidth(line) / wrapWidth)),
    0,
  );
}

export function fitPreviewLines(
  lines: string[],
  maxRows: number,
  width: number,
  maxLines = Number.POSITIVE_INFINITY,
): string[] {
  const shown: string[] = [];
  let usedRows = 0;
  for (const line of lines) {
    const rows = countPreviewRows([line], width);
    if (shown.length >= maxLines || usedRows + rows > maxRows) {
      break;
    }
    shown.push(line);
    usedRows += rows;
  }
  if (shown.length === lines.length) {
    return lines;
  }
  while (shown.length > 0 && usedRows > maxRows - 1) {
    usedRows -= countPreviewRows([shown.pop() ?? ""], width);
  }
  shown.push(`… (${lines.length - shown.length} more lines)`);
  return shown;
}
