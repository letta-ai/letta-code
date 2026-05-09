import type { AdvancedDiffSuccess } from "../helpers/diff";

export function countWrappedLines(text: string, width: number): number {
  if (!text) return 0;
  const wrapWidth = Math.max(1, width);
  return text.split(/\r?\n/).reduce((sum, line) => {
    const len = line.length;
    const wrapped = Math.max(1, Math.ceil(len / wrapWidth));
    return sum + wrapped;
  }, 0);
}

export function countWrappedLinesFromList(
  lines: string[],
  width: number,
): number {
  if (!lines.length) return 0;
  const wrapWidth = Math.max(1, width);
  return lines.reduce((sum, line) => {
    const len = line.length;
    const wrapped = Math.max(1, Math.ceil(len / wrapWidth));
    return sum + wrapped;
  }, 0);
}

export function estimateAdvancedDiffLines(
  diff: AdvancedDiffSuccess,
  width: number,
): number {
  const wrapWidth = Math.max(1, width);
  let total = 0;
  for (const hunk of diff.hunks) {
    for (const line of hunk.lines) {
      const raw = line.raw || "";
      if (raw.startsWith("\\")) continue;
      const text = raw.slice(1);
      total += Math.max(1, Math.ceil(text.length / wrapWidth));
    }
  }
  return total;
}
