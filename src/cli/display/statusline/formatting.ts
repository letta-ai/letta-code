import stripAnsi from "strip-ansi";

export function truncateStatuslineText(
  value: string,
  maxChars: number,
): string {
  if (maxChars <= 0) return "";
  if (value.length <= maxChars) return value;
  if (maxChars <= 3) return value.slice(0, maxChars);
  return `${value.slice(0, maxChars - 3)}...`;
}

/**
 * Visible width of a string, ignoring ANSI escape codes (colors, OSC 8 links).
 * Counts code points rather than UTF-16 units so most emoji count as 1; this
 * is an approximation (no wide-char/grapheme awareness) but matches how the
 * statusline historically measured text.
 */
export function visibleWidth(value: string): number {
  return [...stripAnsi(value)].length;
}

/**
 * Truncate to a visible width, appending "…" when clipped. For simplicity the
 * ellipsis path strips ANSI before slicing; mods that need color-preserving
 * truncation can pre-truncate to `width` themselves.
 */
export function truncateToWidth(value: string, width: number): string {
  if (width <= 0) return "";
  if (visibleWidth(value) <= width) return value;
  if (width === 1) return "…";
  const chars = [...stripAnsi(value)];
  return `${chars.slice(0, width - 1).join("")}…`;
}

/**
 * Lay out a left segment and a right segment across `width`, padding the middle
 * with spaces. ANSI-aware. If the two collide, the left side is truncated.
 */
export function row(left: string, right: string, width: number): string {
  if (width <= 0) return "";
  const rightWidth = visibleWidth(right);
  if (rightWidth >= width) return truncateToWidth(right, width);
  const leftBudget = width - rightWidth;
  const fittedLeft =
    visibleWidth(left) > leftBudget ? truncateToWidth(left, leftBudget) : left;
  const gap = Math.max(0, leftBudget - visibleWidth(fittedLeft));
  return `${fittedLeft}${" ".repeat(gap)}${right}`;
}

/**
 * Distribute parts across `width`: first left-aligned, last right-aligned,
 * middles spread evenly between. ANSI-aware.
 */
export function columns(parts: string[], width: number): string {
  const items = parts.filter((part) => part.length > 0);
  if (items.length === 0) return "";
  if (items.length === 1) return truncateToWidth(items[0]!, width);
  if (items.length === 2) return row(items[0]!, items[1]!, width);
  const totalContent = items.reduce((sum, part) => sum + visibleWidth(part), 0);
  const gaps = items.length - 1;
  const spare = Math.max(gaps, width - totalContent);
  const base = Math.floor(spare / gaps);
  let extra = spare - base * gaps;
  let result = items[0]!;
  for (let i = 1; i < items.length; i += 1) {
    const pad = base + (extra > 0 ? 1 : 0);
    if (extra > 0) extra -= 1;
    result += " ".repeat(pad) + items[i];
  }
  return truncateToWidth(result, width);
}
