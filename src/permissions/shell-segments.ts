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

function readSubstitution(
  input: string,
  start: number,
  allowProcessSubstitution: boolean,
): { end: number; body: string } | null {
  if (input[start] === "`") {
    let i = start + 1;
    while (i < input.length && input[i] !== "`") {
      i += input[i] === "\\" ? 2 : 1;
    }
    const end = Math.min(i + 1, input.length);
    return { end, body: input.slice(start + 1, Math.min(i, input.length)) };
  }

  const isProcessSubstitution =
    allowProcessSubstitution &&
    (input.startsWith("<(", start) || input.startsWith(">(", start));
  if (!input.startsWith("$(", start) && !isProcessSubstitution) return null;

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

    const substitution = readSubstitution(input, i, quote === null);
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
