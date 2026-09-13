import stringWidth from "string-width";
import stripAnsi from "strip-ansi";

const OSC8 = "\x1b]8;;";
const ST = "\x1b\\";

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
 * Visible width of a string in terminal columns, ignoring ANSI escape codes
 * (colors, OSC 8 links) and accounting for wide characters (CJK, emoji) that
 * occupy two columns and zero-width/combining marks.
 */
export function visibleWidth(value: string): number {
  return stringWidth(value);
}

/**
 * Truncate to a visible column width, appending "…" when clipped. The ellipsis
 * path strips ANSI before slicing (truncated output is not color-preserved);
 * mods that need color-preserving truncation can pre-truncate to `width`
 * themselves. Slices by column width so wide characters are not split.
 */
export function truncateToWidth(value: string, width: number): string {
  if (width <= 0) return "";
  if (visibleWidth(value) <= width) return value;
  if (width === 1) return "…";
  const budget = width - 1; // reserve one column for the ellipsis
  let out = "";
  let used = 0;
  for (const ch of stripAnsi(value)) {
    const w = stringWidth(ch);
    if (used + w > budget) break;
    out += ch;
    used += w;
  }
  return `${out}…`;
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
  const first = items[0] ?? "";
  const second = items[1] ?? "";
  if (items.length === 1) return truncateToWidth(first, width);
  if (items.length === 2) return row(first, second, width);
  const totalContent = items.reduce((sum, part) => sum + visibleWidth(part), 0);
  const gaps = items.length - 1;
  const spare = Math.max(gaps, width - totalContent);
  const base = Math.floor(spare / gaps);
  let extra = spare - base * gaps;
  let result = first;
  for (let i = 1; i < items.length; i += 1) {
    const pad = base + (extra > 0 ? 1 : 0);
    if (extra > 0) extra -= 1;
    result += " ".repeat(pad) + items[i];
  }
  return truncateToWidth(result, width);
}

export function link(label: string, url: string): string {
  if (!url) return label;
  return `${OSC8}${url}${ST}${label}${OSC8}${ST}`;
}
