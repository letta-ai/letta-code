import stringWidth from "string-width";

/**
 * Terminal rows `lines` take when wrapped at `width` columns.
 */
export function countPreviewRows(lines: string[], width: number): number {
  const wrapWidth = Math.max(1, width);
  return lines.reduce(
    (sum, line) => sum + Math.max(1, Math.ceil(stringWidth(line) / wrapWidth)),
    0,
  );
}

/**
 * Keep the leading `lines` of an approval preview that fit in `maxRows`
 * terminal rows at `width` columns (and at most `maxLines` lines). Dropped
 * lines become one "… (N more lines)" row.
 *
 * Inline approvals render in Ink's live area, and a live area as tall as the
 * terminal is clipped to its bottom rows. A preview that fits keeps the
 * approval header and the start of what is being approved on screen.
 */
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
  // Make room for the marker row.
  while (shown.length > 0 && usedRows > maxRows - 1) {
    usedRows -= countPreviewRows([shown.pop() ?? ""], width);
  }
  shown.push(`… (${lines.length - shown.length} more lines)`);
  return shown;
}
