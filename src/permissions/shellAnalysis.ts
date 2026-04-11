export type ShellAnalysisNode =
  | {
      type: "command";
      segment: string;
    }
  | {
      type: "if";
      condition: string;
      thenBody: ShellAnalysisNode[];
    }
  | {
      type: "for";
      variableName: string;
      items: string[];
      body: ShellAnalysisNode[];
    };

/**
 * Check if a redirect at position `pos` in `input` is safe to allow.
 * Safe redirects write only to /dev/null or duplicate file descriptors (>&N).
 * Returns the number of characters consumed by the redirect operator and target
 * (0 if the redirect is not safe and should cause rejection).
 */
function tryConsumeSafeRedirect(input: string, pos: number): number {
  const isAppend = input.startsWith(">>", pos);
  const opLen = isAppend ? 2 : 1;
  let cursor = pos + opLen;

  if (cursor < input.length && input[cursor] === "&") {
    cursor += 1;
    const fdStart = cursor;
    while (cursor < input.length && /[0-9]/.test(input[cursor] ?? "")) {
      cursor += 1;
    }
    return cursor > fdStart ? cursor - pos : 0;
  }

  while (
    cursor < input.length &&
    (input[cursor] === " " || input[cursor] === "\t")
  ) {
    cursor += 1;
  }

  if (cursor >= input.length) {
    return 0;
  }

  const targetStart = cursor;
  while (
    cursor < input.length &&
    !/[\s;|&><()`$'"]/.test(input[cursor] ?? "")
  ) {
    cursor += 1;
  }

  const target = input.slice(targetStart, cursor);
  return target === "/dev/null" ? cursor - pos : 0;
}

/**
 * Split a shell command into segments on unquoted separators: |, &&, ||, ;
 * Returns null if dangerous operators are found:
 * - redirects (>, >>) outside quotes (unless targeting /dev/null or fd duplication)
 * - command substitution ($(), backticks) outside single quotes
 */
export function splitShellSegments(input: string): string[] | null {
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

    if (input.startsWith(">>", i) || ch === ">") {
      const skipLen = tryConsumeSafeRedirect(input, i);
      if (skipLen > 0) {
        i += skipLen;
        continue;
      }
      return null;
    }

    if (ch === "`" || input.startsWith("$(", i)) {
      return null;
    }

    if (input.startsWith("&&", i)) {
      segments.push(current);
      current = "";
      i += 2;
      continue;
    }

    if (input.startsWith("||", i)) {
      segments.push(current);
      current = "";
      i += 2;
      continue;
    }

    if (ch === ";") {
      segments.push(current);
      current = "";
      i += 1;
      continue;
    }

    if (ch === "\n" || ch === "\r") {
      segments.push(current);
      current = "";
      i += 1;
      continue;
    }

    if (ch === "|") {
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

export function isShellExecutor(command: string): boolean {
  return command === "bash" || command === "sh";
}

export function stripShellQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

export function tokenizeShellWords(segment: string): string[] {
  const matches = segment.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g);
  if (!matches) {
    return [];
  }
  return matches.map((token) => stripShellQuotes(token));
}

export function extractDashCArgument(tokens: string[]): string | undefined {
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token) {
      continue;
    }
    if (token === "-c" || token === "-lc" || /^-[a-zA-Z]*c$/.test(token)) {
      return tokens[i + 1];
    }
  }
  return undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function substituteShellVariable(
  segment: string,
  variableName: string,
  value: string,
): string {
  const escapedName = escapeRegExp(variableName);
  return segment
    .replace(new RegExp(`\\$\\{${escapedName}\\}`, "g"), value)
    .replace(new RegExp(`\\$${escapedName}(?![A-Za-z0-9_])`, "g"), value);
}

function isReservedShellControlSegment(segment: string): boolean {
  return (
    segment === "fi" ||
    segment === "done" ||
    segment === "then" ||
    segment === "do" ||
    segment.startsWith("then ") ||
    segment.startsWith("do ") ||
    segment === "else" ||
    segment.startsWith("else ")
  );
}

function parseIfNode(
  segments: string[],
  startIndex: number,
): { node: ShellAnalysisNode; nextIndex: number } | null {
  const firstSegment = segments[startIndex]?.trim() ?? "";
  if (!firstSegment.startsWith("if ")) {
    return null;
  }

  const condition = firstSegment.slice(3).trim();
  if (!condition) {
    return null;
  }

  const bodySegments: string[] = [];
  let sawThen = false;

  for (let index = startIndex + 1; index < segments.length; index += 1) {
    const segment = segments[index]?.trim() ?? "";
    if (!segment) {
      continue;
    }

    if (segment === "fi") {
      if (!sawThen || bodySegments.length === 0) {
        return null;
      }
      const thenBody = parseShellAnalysisSegments(bodySegments);
      if (!thenBody) {
        return null;
      }
      return {
        node: {
          type: "if",
          condition,
          thenBody,
        },
        nextIndex: index + 1,
      };
    }

    if (!sawThen) {
      if (segment === "then") {
        sawThen = true;
        continue;
      }

      if (segment.startsWith("then ")) {
        sawThen = true;
        const inlineBody = segment.slice(5).trim();
        if (inlineBody) {
          bodySegments.push(inlineBody);
        }
        continue;
      }

      return null;
    }

    if (segment === "else" || segment.startsWith("else ")) {
      // Keep the first phase conservative: `else` bodies introduce another
      // branch that permission validation would need to evaluate. Rejecting the
      // structure here keeps the analysis boundary simple until we explicitly
      // decide to support it.
      return null;
    }

    bodySegments.push(segment);
  }

  return null;
}

function parseForNode(
  segments: string[],
  startIndex: number,
): { node: ShellAnalysisNode; nextIndex: number } | null {
  const firstSegment = segments[startIndex]?.trim() ?? "";
  const tokens = tokenizeShellWords(firstSegment);
  const variableName = tokens[1];

  if (
    tokens[0] !== "for" ||
    !variableName ||
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(variableName) ||
    tokens[2] !== "in"
  ) {
    return null;
  }

  const items = tokens.slice(3);
  if (items.length === 0) {
    return null;
  }

  const bodySegments: string[] = [];
  let sawDo = false;

  for (let index = startIndex + 1; index < segments.length; index += 1) {
    const segment = segments[index]?.trim() ?? "";
    if (!segment) {
      continue;
    }

    if (segment === "done") {
      if (!sawDo || bodySegments.length === 0) {
        return null;
      }
      const body = parseShellAnalysisSegments(bodySegments);
      if (!body) {
        return null;
      }
      return {
        node: {
          type: "for",
          variableName,
          items,
          body,
        },
        nextIndex: index + 1,
      };
    }

    if (!sawDo) {
      if (segment === "do") {
        sawDo = true;
        continue;
      }

      if (segment.startsWith("do ")) {
        sawDo = true;
        const inlineBody = segment.slice(3).trim();
        if (inlineBody) {
          bodySegments.push(inlineBody);
        }
        continue;
      }

      return null;
    }

    bodySegments.push(segment);
  }

  return null;
}

/**
 * Convert already-split shell segments into a structured analysis tree.
 * Returns null when the segment sequence uses unsupported or malformed control
 * flow so callers can fall back to a conservative deny.
 */
export function parseShellAnalysisSegments(
  segments: string[],
): ShellAnalysisNode[] | null {
  const nodes: ShellAnalysisNode[] = [];

  for (let index = 0; index < segments.length; ) {
    const segment = segments[index]?.trim() ?? "";
    if (!segment) {
      index += 1;
      continue;
    }

    if (segment.startsWith("if ")) {
      const parsed = parseIfNode(segments, index);
      if (!parsed) {
        return null;
      }
      nodes.push(parsed.node);
      index = parsed.nextIndex;
      continue;
    }

    if (segment.startsWith("for ")) {
      const parsed = parseForNode(segments, index);
      if (!parsed) {
        return null;
      }
      nodes.push(parsed.node);
      index = parsed.nextIndex;
      continue;
    }

    if (isReservedShellControlSegment(segment)) {
      return null;
    }

    nodes.push({
      type: "command",
      segment,
    });
    index += 1;
  }

  return nodes;
}

export function parseShellAnalysis(
  command: string,
): ShellAnalysisNode[] | null {
  const trimmed = command.trim();
  if (!trimmed) {
    return null;
  }

  const segments = splitShellSegments(trimmed);
  if (!segments || segments.length === 0) {
    return null;
  }

  return parseShellAnalysisSegments(segments);
}
