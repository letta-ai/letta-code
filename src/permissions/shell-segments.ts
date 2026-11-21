// src/permissions/shell-segments.ts
// Splitting compound shell commands into segments, shared by the read-only
// auto-approval check and deny-rule matching.

/**
 * True when the `&` at `input[i]` is the background operator, which ends a
 * command like `;` does. `current` is the segment text read so far.
 * `&&`, `&>` and `>&N` / `<&N` fd duplication are not separators.
 */
export function isBackgroundAmpersand(
  input: string,
  i: number,
  current: string,
): boolean {
  if (input[i] !== "&") return false;
  const next = input[i + 1];
  if (next === "&" || next === ">") return false;
  return !/[<>]$/.test(current);
}

function isSegmentSeparator(input: string, i: number, current: string) {
  const ch = input[i];
  return (
    ch === ";" ||
    ch === "|" ||
    ch === "\n" ||
    ch === "\r" ||
    isBackgroundAmpersand(input, i, current)
  );
}

/**
 * Split on unquoted `;`, `|`, `&`, `&&`, `||` and newlines, keeping redirects
 * inside their segment. Returns null on command substitution.
 */
export function splitShellSegmentsAllowUnsafeRedirects(
  input: string,
): string[] | null {
  const segments: string[] = [];
  let current = "";
  let i = 0;
  let quote: "single" | "double" | null = null;

  while (i < input.length) {
    const ch = input[i];

    if (!ch) {
      i += 1;
      continue;
    }

    if (quote === "single") {
      current += ch;
      if (ch === "'") {
        quote = null;
      }
      i += 1;
      continue;
    }

    if (quote === "double") {
      if (ch === "\\" && i + 1 < input.length) {
        current += input.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (ch === "`" || input.startsWith("$(", i)) {
        return null;
      }
      current += ch;
      if (ch === '"') {
        quote = null;
      }
      i += 1;
      continue;
    }

    if (ch === "'") {
      quote = "single";
      current += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      quote = "double";
      current += ch;
      i += 1;
      continue;
    }

    if (ch === "\\" && i + 1 < input.length) {
      current += input.slice(i, i + 2);
      i += 2;
      continue;
    }

    if (ch === "`" || input.startsWith("$(", i)) {
      return null;
    }

    if (input.startsWith("&&", i) || input.startsWith("||", i)) {
      segments.push(current);
      current = "";
      i += 2;
      continue;
    }

    if (isSegmentSeparator(input, i, current)) {
      segments.push(current);
      current = "";
      i += 1;
      continue;
    }

    current += ch;
    i += 1;
  }

  segments.push(current);
  return segments.map((segment) => segment.trim()).filter(Boolean);
}

/**
 * Find the end of a `$(...)` or backtick substitution starting at `start`.
 * Returns the index just past it and its body. Unterminated substitutions
 * run to the end of the input.
 */
function readSubstitution(
  input: string,
  start: number,
): { end: number; body: string } | null {
  if (input[start] === "`") {
    let i = start + 1;
    while (i < input.length && input[i] !== "`") {
      i += input[i] === "\\" ? 2 : 1;
    }
    const end = Math.min(i + 1, input.length);
    return { end, body: input.slice(start + 1, Math.min(i, input.length)) };
  }

  if (!input.startsWith("$(", start)) return null;

  let depth = 1;
  let quote: "single" | "double" | null = null;
  let i = start + 2;
  while (i < input.length) {
    const ch = input[i];
    if (quote === "single") {
      if (ch === "'") quote = null;
    } else if (ch === "\\") {
      i += 1;
    } else if (quote === "double") {
      if (ch === '"') quote = null;
    } else if (ch === "'") {
      quote = "single";
    } else if (ch === '"') {
      quote = "double";
    } else if (ch === "(") {
      depth += 1;
    } else if (ch === ")") {
      depth -= 1;
      if (depth === 0) {
        return { end: i + 1, body: input.slice(start + 2, i) };
      }
    }
    i += 1;
  }
  return { end: input.length, body: input.slice(start + 2) };
}

/**
 * Split a command into every segment that may run, for deny-rule matching.
 * Unlike the read-only splitters this never bails out: redirects stay in
 * their segment, and the bodies of `$(...)` and backtick substitutions
 * (outside single quotes) are split and returned as extra segments.
 */
export function splitShellSegmentsForDenyMatching(input: string): string[] {
  const segments: string[] = [];
  const nested: string[] = [];
  let current = "";
  let quote: "single" | "double" | null = null;
  let i = 0;

  const flush = () => {
    const trimmed = current.trim();
    if (trimmed) segments.push(trimmed);
    current = "";
  };

  while (i < input.length) {
    const ch = input[i] ?? "";

    if (quote === "single") {
      current += ch;
      if (ch === "'") quote = null;
      i += 1;
      continue;
    }

    if (ch === "\\" && i + 1 < input.length) {
      current += input.slice(i, i + 2);
      i += 2;
      continue;
    }

    const substitution = readSubstitution(input, i);
    if (substitution) {
      nested.push(...splitShellSegmentsForDenyMatching(substitution.body));
      current += input.slice(i, substitution.end);
      i = substitution.end;
      continue;
    }

    if (quote === "double") {
      current += ch;
      if (ch === '"') quote = null;
      i += 1;
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch === "'" ? "single" : "double";
      current += ch;
      i += 1;
      continue;
    }

    if (input.startsWith("&&", i) || input.startsWith("||", i)) {
      flush();
      i += 2;
      continue;
    }

    if (isSegmentSeparator(input, i, current)) {
      flush();
      i += 1;
      continue;
    }

    current += ch;
    i += 1;
  }

  flush();
  return [...segments, ...nested];
}
