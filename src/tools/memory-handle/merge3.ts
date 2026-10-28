/**
 * Line-based three-way merge for memory documents. Changes on both sides
 * combine when they touch disjoint base lines; insertions at the same point
 * keep both (ours first), so concurrent appends to one file merge. Overlapping
 * edits return null for the caller to resolve.
 */

import * as Diff from "diff";

interface Edit {
  /** Base line range [start, end) replaced by `lines`. */
  start: number;
  end: number;
  lines: string[];
}

function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function edits(base: string[], other: string[]): Edit[] {
  const out: Edit[] = [];
  let position = 0;
  let current: Edit | null = null;
  for (const part of Diff.diffArrays(base, other)) {
    const count = part.count ?? part.value.length;
    if (!part.added && !part.removed) {
      if (current) out.push(current);
      current = null;
      position += count;
      continue;
    }
    current ??= { start: position, end: position, lines: [] };
    if (part.removed) {
      position += count;
      current.end = position;
    } else {
      current.lines.push(...part.value);
    }
  }
  if (current) out.push(current);
  return out;
}

export function merge3(
  base: string,
  ours: string,
  theirs: string,
): string | null {
  if (ours === theirs) return ours;
  if (ours === base) return theirs;
  if (theirs === base) return ours;
  const lines = splitLines(base);
  const left = edits(lines, splitLines(ours));
  const right = edits(lines, splitLines(theirs));
  const out: string[] = [];
  let position = 0;
  const emit = (edit: Edit, extra: string[] = []) => {
    out.push(...lines.slice(position, edit.start), ...edit.lines, ...extra);
    position = edit.end;
  };
  const insertion = (edit: Edit) => edit.start === edit.end;
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    const a = left[i];
    const b = right[j];
    if (!a || !b) {
      emit((a ?? b) as Edit);
      if (a) i++;
      else j++;
      continue;
    }
    if (
      a.start === b.start &&
      a.end === b.end &&
      a.lines.join("") === b.lines.join("")
    ) {
      emit(a);
      i++;
      j++;
      continue;
    }
    if (insertion(a) && insertion(b) && a.start === b.start) {
      emit(a, b.lines);
      i++;
      j++;
      continue;
    }
    const inside = (x: Edit, y: Edit) =>
      insertion(x) && y.start < x.start && x.start < y.end;
    if ((a.start < b.end && b.start < a.end) || inside(a, b) || inside(b, a)) {
      return null;
    }
    if (a.start < b.start || (a.start === b.start && a.end <= b.end)) {
      emit(a);
      i++;
    } else {
      emit(b);
      j++;
    }
  }
  out.push(...lines.slice(position));
  return out.join("");
}
