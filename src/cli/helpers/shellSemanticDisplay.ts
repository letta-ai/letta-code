import { relative } from "node:path";
import { unwrapShellLauncherCommand } from "../../permissions/shell-command-normalization.js";

export type ShellSemanticDisplay = {
  kind: "read" | "list" | "search" | "run";
  label: "Read" | "List" | "Search" | "Run";
  summary: string;
  rawCommand: string;
};

type SequenceContext = {
  contextPath?: string;
  loopVariables: Map<string, string>;
};

function formatSummaryFields(
  fields: Array<[label: string, value: string | number | undefined]>,
): string {
  return fields
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([label, value]) => `${label}: ${String(value)}`)
    .join(", ");
}

function quoteSummaryValue(value: string): string {
  return JSON.stringify(value);
}

function parseCountArgument(tokens: string[]): number | undefined {
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token) {
      continue;
    }

    if (token === "-n" || token === "-c") {
      const value = tokens[i + 1];
      if (value && /^\d+$/.test(value)) {
        return Number(value);
      }
      continue;
    }

    const shortFlagMatch = /^-(?:n|c)(\d+)$/.exec(token);
    if (shortFlagMatch?.[1]) {
      return Number(shortFlagMatch[1]);
    }

    const longFlagMatch = /^--(?:lines|bytes)=(\d+)$/.exec(token);
    if (longFlagMatch?.[1]) {
      return Number(longFlagMatch[1]);
    }
  }

  return undefined;
}

function parseSedRange(expression: string | undefined): {
  startLine?: number;
  endLine?: number;
} {
  if (!expression) {
    return {};
  }

  const rangeMatch = /^(\d+),(\d+)p$/.exec(expression);
  if (rangeMatch?.[1] && rangeMatch[2]) {
    return {
      startLine: Number(rangeMatch[1]),
      endLine: Number(rangeMatch[2]),
    };
  }

  const singleLineMatch = /^(\d+)p$/.exec(expression);
  if (singleLineMatch?.[1]) {
    const line = Number(singleLineMatch[1]);
    return {
      startLine: line,
      endLine: line,
    };
  }

  return {};
}

function isReadOnlyFind(tokens: string[]): boolean {
  return !tokens.some((token) =>
    [
      "-delete",
      "-exec",
      "-execdir",
      "-ok",
      "-okdir",
      "-fprint",
      "-fprintf",
      "-fls",
    ].includes(token),
  );
}

function formatDisplayPath(filePath: string): string {
  const normalizePathSeparators = (value: string): string =>
    value.replace(/\\/g, "/");

  if (filePath === ".") {
    return ".";
  }

  const cwd = process.cwd();
  const relativePath = relative(cwd, filePath);
  if (relativePath === "") {
    return ".";
  }
  if (relativePath.startsWith("..")) {
    return normalizePathSeparators(filePath);
  }
  return normalizePathSeparators(relativePath);
}

function tokenizeShell(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "single" | "double" | null = null;
  let escaping = false;

  const flush = () => {
    if (current.length > 0) {
      tokens.push(current);
      current = "";
    }
  };

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (ch === undefined) {
      continue;
    }

    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }

    if (ch === "\\" && quote !== "single") {
      escaping = true;
      continue;
    }

    if (quote === "single") {
      if (ch === "'") {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (quote === "double") {
      if (ch === '"') {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === "'") {
      quote = "single";
      continue;
    }

    if (ch === '"') {
      quote = "double";
      continue;
    }

    const next = input[i + 1];
    if ((ch === "&" || ch === "|" || ch === ">" || ch === "<") && next === ch) {
      flush();
      tokens.push(ch + next);
      i += 1;
      continue;
    }

    if (ch === "|" || ch === "&" || ch === ";" || ch === ">" || ch === "<") {
      flush();
      tokens.push(ch);
      continue;
    }

    if (/\s/.test(ch)) {
      flush();
      continue;
    }

    current += ch;
  }

  if (escaping) {
    current += "\\";
  }

  flush();
  return tokens;
}

function splitByOperator(tokens: string[], operator: string): string[][] {
  const segments: string[][] = [];
  let current: string[] = [];

  for (const token of tokens) {
    if (token === operator) {
      if (current.length === 0) {
        return [];
      }
      segments.push(current);
      current = [];
      continue;
    }
    current.push(token);
  }

  if (current.length === 0) {
    return [];
  }

  segments.push(current);
  return segments;
}

function splitOnSequenceConnectors(tokens: string[]): string[][] {
  const segments: string[][] = [];
  let current: string[] = [];

  for (const token of tokens) {
    if (token === ";" || token === "&&" || token === "||") {
      if (current.length > 0) {
        segments.push(current);
        current = [];
      }
      continue;
    }
    current.push(token);
  }

  if (current.length > 0) {
    segments.push(current);
  }

  return segments;
}

function hasUnsupportedSyntax(rawCommand: string, tokens: string[]): boolean {
  if (rawCommand.includes("$(") || rawCommand.includes("`")) {
    return true;
  }

  return tokens.some(
    (token) =>
      token === "&" ||
      token === ">" ||
      token === ">>" ||
      token === "<" ||
      token === "<<",
  );
}

function stripNonSemanticRedirections(command: string): string {
  return command
    .replace(/\b\d*>\s*\/dev\/null\b/g, "")
    .replace(/\b\d*>\s*&\d\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function splitPipeline(tokens: string[]): string[][] {
  return splitByOperator(tokens, "|");
}

function isFormatterSegment(tokens: string[]): boolean {
  const [head, ...tail] = tokens;
  if (!head) {
    return false;
  }

  switch (head) {
    case "head":
    case "tail":
      return nonFlagOperands(tail, new Set(["-n", "-c"])).length === 0;
    case "wc":
    case "sort":
    case "uniq":
    case "column":
    case "nl":
    case "printf":
    case "echo":
      return nonFlagOperands(tail).length === 0;
    case "sed":
      return (
        tokens[1] === "-n" &&
        nonFlagOperands(tail, new Set(["-e", "-f"])).length <= 1
      );
    default:
      return false;
  }
}

function isShellExecutor(token: string): boolean {
  const basename = token.split("/").pop() ?? token;
  return ["bash", "sh", "zsh", "dash", "ksh"].includes(basename.toLowerCase());
}

function normalizeRawCommand(command: string | string[]): string {
  if (Array.isArray(command)) {
    const [head, second, third] = command;
    if (
      typeof head === "string" &&
      typeof second === "string" &&
      typeof third === "string" &&
      isShellExecutor(head) &&
      (second === "-c" || second === "-lc")
    ) {
      return unwrapShellLauncherCommand(third.trim());
    }
    return unwrapShellLauncherCommand(command.join(" ").trim());
  }

  return unwrapShellLauncherCommand(command.trim());
}

function combineContextPath(
  contextPath: string | undefined,
  path: string | undefined,
): string | undefined {
  if (!contextPath) {
    return path;
  }

  if (!path) {
    return contextPath;
  }

  if (
    path.startsWith("/") ||
    path.startsWith("~") ||
    path.startsWith("../") ||
    path.startsWith("./")
  ) {
    return path;
  }

  return `${contextPath.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function nonFlagOperands(
  tokens: string[],
  flagsWithValues: Set<string> = new Set(),
): string[] {
  const operands: string[] = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token) {
      continue;
    }

    if (flagsWithValues.has(token)) {
      i += 1;
      continue;
    }

    if (token.startsWith("-")) {
      continue;
    }

    operands.push(token);
  }

  return operands;
}

function parseQueryOperand(
  tokens: string[],
  flagsWithValues: Set<string>,
): string | undefined {
  return nonFlagOperands(tokens, flagsWithValues)[0];
}

function parsePathFilterSegment(tokens: string[]): string | undefined {
  const [head, ...tail] = tokens;
  if (!head) {
    return undefined;
  }

  if (
    head === "rg" ||
    head === "rga" ||
    head === "ripgrep-all" ||
    head === "grep" ||
    head === "egrep" ||
    head === "fgrep" ||
    head === "ag" ||
    head === "ack"
  ) {
    if (tail.includes("--files")) {
      return undefined;
    }

    return parseQueryOperand(
      tail,
      new Set(["-e", "-f", "-m", "-A", "-B", "-C", "--max-count"]),
    );
  }

  return undefined;
}

function trimLeadingControlTokens(tokens: string[]): string[] {
  let current = tokens;
  while (current[0] === "then" || current[0] === "do") {
    current = current.slice(1);
  }
  return current;
}

function isIgnoredSequenceSegment(tokens: string[]): boolean {
  const [head] = tokens;
  if (!head) {
    return true;
  }

  return [
    "printf",
    "echo",
    ":",
    "true",
    "if",
    "fi",
    "else",
    "[",
    "]",
    "test",
  ].includes(head);
}

function maybeCaptureLoopVariable(
  tokens: string[],
  loopVariables: Map<string, string>,
): boolean {
  if (tokens[0] !== "for" || tokens[2] !== "in") {
    return false;
  }

  const variableName = tokens[1];
  const loopValue = tokens[3];
  if (!variableName || !loopValue) {
    return true;
  }

  loopVariables.set(variableName, loopValue);
  return true;
}

function substituteLoopVariables(
  tokens: string[],
  loopVariables: Map<string, string>,
): string[] {
  return tokens.map((token) => {
    const variableName =
      /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(token)?.[1] ??
      /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(token)?.[1];
    if (!variableName) {
      return token;
    }

    return loopVariables.get(variableName) ?? token;
  });
}

function analyzeHelperSegments(
  primaryTokens: string[],
  primaryKind: ShellSemanticDisplay["kind"],
  helperSegments: string[][],
): {
  filter?: string;
  limit?: number;
  valid: boolean;
} {
  let filter: string | undefined;
  let limit: number | undefined;

  for (const segment of helperSegments) {
    if (segment.length === 0) {
      continue;
    }

    const [head, ...tail] = segment;
    if (head === "head") {
      limit = parseCountArgument(tail) ?? limit;
      continue;
    }

    if (isFormatterSegment(segment)) {
      continue;
    }

    if (primaryKind === "list") {
      const pathFilter = parsePathFilterSegment(segment);
      if (pathFilter) {
        filter = pathFilter;
        continue;
      }
    }

    if (
      primaryTokens.length === 1 &&
      (primaryTokens[0] === "yes" || primaryTokens[0] === "no")
    ) {
      continue;
    }

    return { valid: false };
  }

  return { filter, limit, valid: true };
}

function buildReadSummary(
  path: string,
  options: {
    startLine?: number;
    endLine?: number;
    lastLines?: number;
  } = {},
): ShellSemanticDisplay {
  const lineSummary =
    typeof options.startLine === "number" && typeof options.endLine === "number"
      ? options.startLine === options.endLine
        ? String(options.startLine)
        : `${options.startLine}-${options.endLine}`
      : undefined;

  const trailingSummary =
    typeof options.lastLines === "number"
      ? `${options.lastLines} lines`
      : undefined;

  return {
    kind: "read",
    label: "Read",
    summary: formatSummaryFields([
      ["path", formatDisplayPath(path)],
      ["lines", lineSummary],
      ["last", trailingSummary],
    ]),
    rawCommand: "",
  };
}

function buildListSummary(
  path: string | undefined,
  options: { filter?: string; limit?: number } = {},
): ShellSemanticDisplay {
  return {
    kind: "list",
    label: "List",
    summary: formatSummaryFields([
      ["path", path ? formatDisplayPath(path) : "."],
      [
        "filter",
        options.filter ? quoteSummaryValue(options.filter) : undefined,
      ],
      ["limit", options.limit],
    ]),
    rawCommand: "",
  };
}

function buildSearchSummary(
  query: string | undefined,
  path: string | undefined,
  options: { limit?: number } = {},
): ShellSemanticDisplay {
  return {
    kind: "search",
    label: "Search",
    summary: formatSummaryFields([
      ["query", query ? quoteSummaryValue(query) : "search"],
      ["path", path ? formatDisplayPath(path) : undefined],
      ["limit", options.limit],
    ]),
    rawCommand: "",
  };
}

function classifyPrimaryCommand(
  tokens: string[],
  contextPath: string | undefined,
  helperAnalysis: {
    filter?: string;
    limit?: number;
  },
): Omit<ShellSemanticDisplay, "rawCommand"> | null {
  const [head, ...tail] = tokens;
  if (!head) {
    return null;
  }

  if (head === "git") {
    const [subcommand, ...subTail] = tail;
    if (subcommand === "grep") {
      const operands = nonFlagOperands(
        subTail,
        new Set(["-e", "-f", "-m", "-A", "-B", "-C", "--max-count"]),
      );
      const [query, path] = operands;
      if (!query) {
        return null;
      }
      return buildSearchSummary(query, combineContextPath(contextPath, path), {
        limit: helperAnalysis.limit,
      });
    }
    if (subcommand === "ls-files") {
      const operands = nonFlagOperands(
        subTail,
        new Set(["--exclude", "--exclude-from", "--pathspec-from-file"]),
      );
      return buildListSummary(combineContextPath(contextPath, operands[0]), {
        filter: helperAnalysis.filter,
        limit: helperAnalysis.limit,
      });
    }
    return null;
  }

  if (head === "rg" || head === "rga" || head === "ripgrep-all") {
    const hasFilesFlag = tail.includes("--files");
    const operands = nonFlagOperands(
      tail,
      new Set([
        "-g",
        "--glob",
        "--iglob",
        "-t",
        "--type",
        "--type-add",
        "--type-not",
        "-m",
        "--max-count",
        "-A",
        "-B",
        "-C",
        "--context",
        "--max-depth",
      ]),
    );

    if (hasFilesFlag) {
      return buildListSummary(combineContextPath(contextPath, operands[0]), {
        filter: helperAnalysis.filter,
        limit: helperAnalysis.limit,
      });
    }

    const [query, path] = operands;
    if (!query) {
      return null;
    }
    return buildSearchSummary(query, combineContextPath(contextPath, path), {
      limit: helperAnalysis.limit,
    });
  }

  if (
    head === "grep" ||
    head === "egrep" ||
    head === "fgrep" ||
    head === "ag" ||
    head === "ack"
  ) {
    const operands = nonFlagOperands(
      tail,
      new Set(["-e", "-f", "-m", "-A", "-B", "-C", "--max-count"]),
    );
    const [query, path] = operands;
    if (!query) {
      return null;
    }
    return buildSearchSummary(query, combineContextPath(contextPath, path), {
      limit: helperAnalysis.limit,
    });
  }

  if (head === "ls" || head === "eza" || head === "exa") {
    const operands = nonFlagOperands(
      tail,
      new Set([
        "-I",
        "--ignore-glob",
        "-w",
        "--block-size",
        "--format",
        "--time-style",
        "--color",
        "--quoting-style",
        "--sort",
        "--time",
      ]),
    );
    return buildListSummary(combineContextPath(contextPath, operands[0]), {
      filter: helperAnalysis.filter,
      limit: helperAnalysis.limit,
    });
  }

  if (head === "tree") {
    const operands = nonFlagOperands(
      tail,
      new Set(["-L", "-P", "-I", "--charset", "--filelimit", "--sort"]),
    );
    return buildListSummary(combineContextPath(contextPath, operands[0]), {
      filter: helperAnalysis.filter,
      limit: helperAnalysis.limit,
    });
  }

  if (head === "du") {
    const operands = nonFlagOperands(
      tail,
      new Set([
        "-d",
        "--max-depth",
        "-B",
        "--block-size",
        "--exclude",
        "--time-style",
      ]),
    );
    return buildListSummary(combineContextPath(contextPath, operands[0]), {
      filter: helperAnalysis.filter,
      limit: helperAnalysis.limit,
    });
  }

  if (head === "find" && isReadOnlyFind(tail)) {
    const operands = nonFlagOperands(
      tail,
      new Set([
        "-name",
        "-iname",
        "-path",
        "-ipath",
        "-type",
        "-maxdepth",
        "-mindepth",
      ]),
    );
    const root =
      tail[0] && !tail[0].startsWith("-")
        ? combineContextPath(contextPath, tail[0])
        : combineContextPath(contextPath, undefined);
    return buildListSummary(root ?? operands[0], {
      filter: helperAnalysis.filter,
      limit: helperAnalysis.limit,
    });
  }

  if (
    head === "cat" ||
    head === "bat" ||
    head === "batcat" ||
    head === "less" ||
    head === "more" ||
    head === "nl"
  ) {
    const operands = nonFlagOperands(tail);
    const path = combineContextPath(contextPath, operands[0]);
    return path ? buildReadSummary(path) : null;
  }

  if (head === "head" || head === "tail") {
    const operands = nonFlagOperands(tail, new Set(["-n", "-c"]));
    const path = combineContextPath(contextPath, operands[0]);
    const count = parseCountArgument(tail);
    if (!path) {
      return null;
    }
    if (head === "head" && typeof count === "number") {
      return buildReadSummary(path, {
        startLine: 1,
        endLine: count,
      });
    }
    if (head === "tail" && typeof count === "number") {
      return buildReadSummary(path, {
        lastLines: count,
      });
    }
    return buildReadSummary(path);
  }

  if (head === "sed") {
    if (tokens[1] !== "-n") {
      return null;
    }
    const operands = nonFlagOperands(tail, new Set(["-e", "-f"]));
    if (operands.length < 2) {
      return null;
    }
    const path = combineContextPath(contextPath, operands[operands.length - 1]);
    if (!path) {
      return null;
    }
    const { startLine, endLine } = parseSedRange(operands[0]);
    return buildReadSummary(path, {
      startLine,
      endLine,
    });
  }

  if (head === "awk") {
    const operands = nonFlagOperands(tail, new Set(["-F", "-f", "-v"]));
    if (operands.length < 2) {
      return null;
    }
    const path = combineContextPath(contextPath, operands[operands.length - 1]);
    return path ? buildReadSummary(path) : null;
  }

  return null;
}

function classifyPipelineCommand(
  tokens: string[],
  contextPath: string | undefined,
): Omit<ShellSemanticDisplay, "rawCommand"> | null {
  const pipelineSegments = splitPipeline(tokens);
  if (pipelineSegments.length === 0) {
    return null;
  }

  let primaryTokens = pipelineSegments[0] ?? [];
  let helperSegments = pipelineSegments.slice(1);

  while (
    primaryTokens.length === 1 &&
    (primaryTokens[0] === "yes" || primaryTokens[0] === "no") &&
    helperSegments.length > 0
  ) {
    primaryTokens = helperSegments[0] ?? [];
    helperSegments = helperSegments.slice(1);
  }

  if (primaryTokens.length === 0) {
    return null;
  }

  const primaryGuess = classifyPrimaryCommand(primaryTokens, contextPath, {});
  if (!primaryGuess) {
    return null;
  }

  const helperAnalysis = analyzeHelperSegments(
    primaryTokens,
    primaryGuess.kind,
    helperSegments,
  );
  if (!helperAnalysis.valid) {
    return null;
  }

  return classifyPrimaryCommand(primaryTokens, contextPath, helperAnalysis);
}

function classifySemanticSequence(
  rawCommand: string,
): Omit<ShellSemanticDisplay, "rawCommand"> | null {
  const sanitizedCommand = stripNonSemanticRedirections(rawCommand);
  const tokens = tokenizeShell(sanitizedCommand);

  if (hasUnsupportedSyntax(sanitizedCommand, tokens)) {
    return null;
  }

  const segments = splitOnSequenceConnectors(tokens);
  if (segments.length === 0) {
    return null;
  }

  const context: SequenceContext = {
    loopVariables: new Map<string, string>(),
  };

  for (const segment of segments) {
    const trimmed = trimLeadingControlTokens(segment);
    if (trimmed.length === 0) {
      continue;
    }

    if (trimmed[0] === "done") {
      context.loopVariables.clear();
      continue;
    }

    if (maybeCaptureLoopVariable(trimmed, context.loopVariables)) {
      continue;
    }

    if (trimmed[0] === "cd" && trimmed[1] && trimmed.length === 2) {
      context.contextPath = combineContextPath(context.contextPath, trimmed[1]);
      continue;
    }

    if (isIgnoredSequenceSegment(trimmed)) {
      continue;
    }

    const substituted = substituteLoopVariables(trimmed, context.loopVariables);
    const parsed = classifyPipelineCommand(substituted, context.contextPath);
    if (parsed) {
      return parsed;
    }
  }

  return null;
}

export function summarizeShellDisplay(
  command: string | string[],
): ShellSemanticDisplay {
  const rawCommand = normalizeRawCommand(command);
  if (!rawCommand) {
    return {
      kind: "run",
      label: "Run",
      summary: "",
      rawCommand,
    };
  }

  const classified = classifySemanticSequence(rawCommand);
  if (!classified) {
    return {
      kind: "run",
      label: "Run",
      summary: rawCommand,
      rawCommand,
    };
  }

  return {
    ...classified,
    rawCommand,
  };
}
