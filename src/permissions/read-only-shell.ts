import { homedir } from "node:os";
import { resolve } from "node:path";

import { isPathWithinRoots, normalizeMemoryPath } from "./memory-paths";
import {
  extractDashCArgument,
  isShellExecutor,
  parseShellAnalysis,
  type ShellAnalysisNode,
  splitShellSegments,
  stripShellQuotes,
  substituteShellVariable,
  tokenizeShellWords,
} from "./shell-analysis";

const ALWAYS_SAFE_COMMANDS = new Set([
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "grep",
  "rg",
  "ag",
  "ack",
  "fgrep",
  "egrep",
  "ls",
  "tree",
  "file",
  "stat",
  "du",
  "df",
  "wc",
  "diff",
  "cmp",
  "comm",
  "cut",
  "tr",
  "nl",
  "column",
  "fold",
  "pwd",
  "whoami",
  "hostname",
  "date",
  "uname",
  "uptime",
  "id",
  "echo",
  "printf",
  "printenv",
  "which",
  "whereis",
  "type",
  "basename",
  "dirname",
  "realpath",
  "readlink",
  "jq",
  "yq",
  "strings",
  "xxd",
  "hexdump",
  "cd",
  "true",
]);

// These commands inspect directory/path metadata but do not read file contents,
// so absolute or home-anchored paths are still considered read-only.
const EXTERNAL_PATH_METADATA_COMMANDS = new Set([
  "ls",
  "tree",
  "stat",
  "du",
  "realpath",
  "readlink",
  "basename",
  "dirname",
]);

export const SAFE_GIT_SUBCOMMAND_LIST = [
  "status",
  "diff",
  "log",
  "show",
  "grep",
  "branch",
  "tag",
  "remote",
  "rev-parse",
  "ls-files",
  "ls-tree",
  "cat-file",
  "describe",
  "blame",
  "shortlog",
  "name-rev",
  "rev-list",
  "for-each-ref",
  "count-objects",
  "verify-commit",
  "verify-tag",
] as const;

const SAFE_GIT_SUBCOMMANDS = new Set<string>(SAFE_GIT_SUBCOMMAND_LIST);

const UNSAFE_FIND_OPTIONS = new Set([
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-delete",
  "-fls",
  "-fprint",
  "-fprint0",
  "-fprintf",
]);

const UNSAFE_RIPGREP_OPTIONS_WITH_ARGS = new Set(["--pre", "--hostname-bin"]);

const UNSAFE_RIPGREP_OPTIONS_WITHOUT_ARGS = new Set(["--search-zip", "-z"]);

const UNSAFE_GIT_FLAGS = new Set([
  "--output",
  "--ext-diff",
  "--textconv",
  "--exec",
  "--paginate",
]);

const SAFE_MEMORY_GIT_SUBCOMMANDS = new Set([
  "add",
  "commit",
  "config",
  "check-ignore",
  "fetch",
  "push",
  "pull",
  "rebase",
  "reset",
  "restore",
  "status",
  "diff",
  "log",
  "show",
  "show-ref",
  "branch",
  "tag",
  "remote",
  "rm",
  "mv",
  "merge",
  "worktree",
]);

const SAFE_MEMORY_COMMANDS = new Set([
  "git",
  "rm",
  "mv",
  "mkdir",
  "cp",
  "ls",
  "cat",
  "head",
  "tail",
  "find",
  "sort",
  "echo",
  "printf",
  "wc",
  "split",
  "cd",
  "sleep",
]);

// letta CLI read-only subcommands: group -> allowed actions
const SAFE_LETTA_COMMANDS: Record<string, Set<string>> = {
  memory: new Set(["status", "help", "backups", "export", "tokens"]),
  // Legacy alias for `letta memory ...`.
  memfs: new Set(["status", "help", "backups", "export", "tokens"]),
  agents: new Set(["list", "help"]),
  messages: new Set(["search", "list", "help"]),
};

// gh CLI read-only commands: category -> allowed actions
// null means any action is allowed for that category
export const SAFE_GH_COMMANDS: Record<string, Set<string> | null> = {
  pr: new Set(["list", "status", "checks", "diff", "view"]),
  issue: new Set(["list", "status", "view"]),
  repo: new Set(["list", "view", "gitignore", "license"]),
  run: new Set(["list", "view", "watch", "download"]),
  release: new Set(["list", "view", "download"]),
  search: null,
  api: null,
  status: null,
};

const SAFE_FILE_TEST_FLAGS = new Set(["-e", "-f", "-d", "-s", "-L"]);

function isSafeConditionalTest(
  condition: string,
  options: ReadOnlyShellOptions,
): boolean {
  let tokens = tokenizeShellWords(condition);
  if (tokens.length === 0) {
    return false;
  }

  if (tokens[0] === "!") {
    tokens = tokens.slice(1);
  }

  if (tokens[0] === "[") {
    if (tokens[tokens.length - 1] !== "]") {
      return false;
    }
    tokens = tokens.slice(1, -1);
  } else if (tokens[0] === "test") {
    tokens = tokens.slice(1);
  }

  if (tokens.length !== 2) {
    return false;
  }

  const [flag, pathToken] = tokens;
  if (!flag || !pathToken || !SAFE_FILE_TEST_FLAGS.has(flag)) {
    return false;
  }

  if (!options.allowExternalPaths && hasDisallowedPathArg(pathToken, options)) {
    return false;
  }

  return true;
}

function substituteAnalysisNode(
  node: ShellAnalysisNode,
  variableName: string,
  value: string,
): ShellAnalysisNode {
  switch (node.type) {
    case "command":
      return {
        type: "command",
        segment: substituteShellVariable(node.segment, variableName, value),
      };
    case "if":
      return {
        type: "if",
        condition: substituteShellVariable(node.condition, variableName, value),
        thenBody: node.thenBody.map((child) =>
          substituteAnalysisNode(child, variableName, value),
        ),
      };
    case "for":
      return {
        type: "for",
        variableName: node.variableName,
        items: node.items.map((item) =>
          substituteShellVariable(item, variableName, value),
        ),
        body: node.body.map((child) =>
          substituteAnalysisNode(child, variableName, value),
        ),
      };
  }
}

function areReadOnlyNodes(
  nodes: ShellAnalysisNode[],
  options: ReadOnlyShellOptions,
): boolean {
  for (const node of nodes) {
    if (node.type === "command") {
      if (!isSafeSegment(node.segment, options)) {
        return false;
      }
      continue;
    }

    if (node.type === "if") {
      if (
        !isSafeConditionalTest(node.condition, options) ||
        node.thenBody.length === 0 ||
        !areReadOnlyNodes(node.thenBody, options)
      ) {
        return false;
      }
      continue;
    }

    if (node.body.length === 0) {
      return false;
    }

    for (const item of node.items) {
      const substitutedBody = node.body.map((child) =>
        substituteAnalysisNode(child, node.variableName, item),
      );
      if (!areReadOnlyNodes(substitutedBody, options)) {
        return false;
      }
    }
  }

  return true;
}

function isSafeFindExecCommand(tokens: string[]): boolean {
  if (tokens.length === 0) {
    return false;
  }

  if (tokens[0] !== "stat") {
    return false;
  }

  return tokens.some((token) => token === "{}");
}

function isSafeFindInvocation(tokens: string[]): boolean {
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) {
      continue;
    }

    if (UNSAFE_FIND_OPTIONS.has(token) && token !== "-exec") {
      return false;
    }

    if (token !== "-exec") {
      continue;
    }

    const execTokens: string[] = [];
    let terminator: string | null = null;
    for (index += 1; index < tokens.length; index += 1) {
      const execToken = tokens[index];
      if (!execToken) {
        continue;
      }
      if (execToken === ";" || execToken === "\\;" || execToken === "+") {
        terminator = execToken;
        break;
      }
      execTokens.push(execToken);
    }

    if (terminator !== "\\;" && terminator !== ";") {
      return false;
    }

    if (!isSafeFindExecCommand(execTokens)) {
      return false;
    }
  }

  return true;
}

function hasUnsafeRipgrepOptions(tokens: string[]): boolean {
  return tokens.slice(1).some((token) => {
    if (UNSAFE_RIPGREP_OPTIONS_WITHOUT_ARGS.has(token)) {
      return true;
    }
    if (
      UNSAFE_RIPGREP_OPTIONS_WITH_ARGS.has(token) ||
      token.startsWith("--pre=") ||
      token.startsWith("--hostname-bin=")
    ) {
      return true;
    }
    return false;
  });
}

function hasUnsafeGitFlags(tokens: string[]): boolean {
  return tokens.slice(1).some((token) => {
    if (
      token === "-c" ||
      token === "--config-env" ||
      (token.startsWith("-c") && token.length > 2) ||
      token.startsWith("--config-env=")
    ) {
      return true;
    }
    if (
      UNSAFE_GIT_FLAGS.has(token) ||
      token.startsWith("--output=") ||
      token.startsWith("--exec=")
    ) {
      return true;
    }
    return false;
  });
}

function isReadOnlyGitBranchArgs(args: string[]): boolean {
  if (args.length === 0) {
    return true;
  }

  const readOnlyFlags = new Set([
    "--list",
    "-l",
    "--show-current",
    "-a",
    "--all",
    "-r",
    "--remotes",
    "-v",
    "-vv",
    "--verbose",
  ]);

  // Filter flags that narrow which branches are listed — purely read-only.
  // Each optionally accepts a commit/object as the next positional argument.
  const readOnlyFilterFlags = new Set([
    "--contains",
    "--no-contains",
    "--merged",
    "--no-merged",
    "--points-at",
  ]);

  let sawReadOnlyFlag = false;
  let sawListFlag = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg) {
      continue;
    }

    if (readOnlyFlags.has(arg)) {
      sawReadOnlyFlag = true;
      if (arg === "--list" || arg === "-l") {
        sawListFlag = true;
      }
      continue;
    }

    if (arg === "--format") {
      if (typeof args[i + 1] !== "string") {
        return false;
      }
      sawReadOnlyFlag = true;
      i += 1;
      continue;
    }

    if (arg.startsWith("--format=")) {
      sawReadOnlyFlag = true;
      continue;
    }

    // Filter flags like --contains, --merged, etc. take an optional commit arg.
    if (readOnlyFilterFlags.has(arg)) {
      sawReadOnlyFlag = true;
      // Consume the optional commit/branch argument if present.
      if (typeof args[i + 1] === "string" && !args[i + 1]?.startsWith("-")) {
        i += 1;
      }
      continue;
    }

    // Pattern arguments are read-only only when listing explicitly.
    if (sawListFlag && !arg.startsWith("-")) {
      sawReadOnlyFlag = true;
      continue;
    }

    return false;
  }

  return sawReadOnlyFlag;
}

function isReadOnlyGitGrepArgs(
  args: string[],
  options: ReadOnlyShellOptions,
): boolean {
  let inPathspecs = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg) {
      continue;
    }

    if (arg === "--") {
      inPathspecs = true;
      continue;
    }

    if (arg === "--no-index") {
      return false;
    }

    if (
      arg === "-O" ||
      arg.startsWith("-O") ||
      arg === "--open-files-in-pager" ||
      arg.startsWith("--open-files-in-pager=") ||
      arg === "--ext-grep"
    ) {
      return false;
    }

    if (arg === "-f") {
      const patternFile = args[i + 1];
      if (!patternFile) {
        return false;
      }
      if (hasDisallowedPathArg(patternFile, options)) {
        return false;
      }
      i += 1;
      continue;
    }

    if (arg.startsWith("-f") && arg.length > 2) {
      if (hasDisallowedPathArg(arg.slice(2), options)) {
        return false;
      }
      continue;
    }

    if (inPathspecs && hasDisallowedPathArg(arg, options)) {
      return false;
    }
  }

  return true;
}

function isSafeEnvInvocation(
  tokens: string[],
  options: ReadOnlyShellOptions,
): boolean {
  if (tokens.length === 1) {
    return true;
  }

  let index = 1;
  while (index < tokens.length) {
    const token = tokens[index];
    if (!token) {
      index += 1;
      continue;
    }

    if (token === "--help" || token === "--version") {
      return tokens.length === 2;
    }

    if (
      token === "-i" ||
      token === "--ignore-environment" ||
      token === "-0" ||
      token === "--null" ||
      token === "-u" ||
      token === "--unset"
    ) {
      // -u/--unset require a following variable name.
      if (token === "-u" || token === "--unset") {
        if (!tokens[index + 1]) {
          return false;
        }
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }

    if (parseScopedAssignmentToken(token)) {
      index += 1;
      continue;
    }

    return isReadOnlyShellCommand(tokens.slice(index).join(" "), options);
  }

  return true;
}

function readRedirectTarget(
  input: string,
  pos: number,
): { token: string; end: number } | null {
  let cursor = pos;
  while (cursor < input.length && /\s/.test(input[cursor] ?? "")) {
    cursor += 1;
  }
  if (cursor >= input.length) {
    return null;
  }

  const quote = input[cursor];
  if (quote === "'" || quote === '"') {
    let end = cursor + 1;
    while (end < input.length) {
      const ch = input[end];
      if (quote === '"' && ch === "\\" && end + 1 < input.length) {
        end += 2;
        continue;
      }
      if (ch === quote) {
        return { token: input.slice(cursor, end + 1), end: end + 1 };
      }
      end += 1;
    }
    return null;
  }

  let end = cursor;
  while (end < input.length && !/[\s;|&><()`]/.test(input[end] ?? "")) {
    end += 1;
  }
  if (end === cursor) {
    return null;
  }
  return { token: input.slice(cursor, end), end };
}

function isScopedRedirectTarget(
  token: string,
  cwd: string | null,
  allowedRoots: string[],
  env: NodeJS.ProcessEnv,
  shellVars: ScopedShellVars,
): boolean {
  const stripped = stripShellQuotes(token);
  if (stripped === "/dev/null" || /^&\d+$/.test(stripped)) {
    return true;
  }
  const resolved = normalizeScopePath(stripped, cwd, env, shellVars);
  return resolved ? isPathWithinRoots(resolved, allowedRoots) : false;
}

function rewriteScopedMemoryRedirects(
  input: string,
  cwd: string | null,
  allowedRoots: string[],
  env: NodeJS.ProcessEnv,
  shellVars: ScopedShellVars,
): string | null {
  let rewritten = "";
  let i = 0;
  let quote: "single" | "double" | null = null;

  while (i < input.length) {
    const ch = input[i];
    if (!ch) {
      i += 1;
      continue;
    }

    if (quote === "single") {
      rewritten += ch;
      if (ch === "'") quote = null;
      i += 1;
      continue;
    }

    if (quote === "double") {
      if (ch === "\\" && i + 1 < input.length) {
        rewritten += input.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (ch === "`" || input.startsWith("$(", i)) {
        return null;
      }
      rewritten += ch;
      if (ch === '"') quote = null;
      i += 1;
      continue;
    }

    if (ch === "'") {
      quote = "single";
      rewritten += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      quote = "double";
      rewritten += ch;
      i += 1;
      continue;
    }

    if (ch === "\\" && i + 1 < input.length) {
      rewritten += input.slice(i, i + 2);
      i += 2;
      continue;
    }

    if (ch === "`" || input.startsWith("$(", i)) {
      return null;
    }

    if (input.startsWith(">>", i) || ch === ">") {
      const op = input.startsWith(">>", i) ? ">>" : ">";
      const target = readRedirectTarget(input, i + op.length);
      if (!target) {
        return null;
      }
      if (
        !isScopedRedirectTarget(target.token, cwd, allowedRoots, env, shellVars)
      ) {
        return null;
      }
      // Preserve shell shape but replace the target with /dev/null so the
      // read-only shell splitter can continue to reject unsafe commands while
      // tolerating this already-validated scoped write redirection.
      rewritten += `${op} /dev/null`;
      i = target.end;
      continue;
    }

    rewritten += ch;
    i += 1;
  }

  return rewritten;
}

function splitShellSegmentsAllowUnsafeRedirects(
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

    if (ch === ";" || ch === "|" || ch === "\n" || ch === "\r") {
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

function extractHeredocWrite(segment: string): {
  path: string;
  delimiter: string;
} | null {
  const match = segment.match(
    /^cat\s+(?:(?:>|>>)\s*(?<path1>"[^"]+"|'[^']+'|\S+)\s+<<-?\s*(?<delim1>"[^"]+"|'[^']+'|\S+)|<<-?\s*(?<delim2>"[^"]+"|'[^']+'|\S+)\s+(?:>|>>)\s*(?<path2>"[^"]+"|'[^']+'|\S+))\s*$/,
  );
  if (!match?.groups) {
    return null;
  }

  const rawPath = match.groups.path1 || match.groups.path2;
  const rawDelim = match.groups.delim1 || match.groups.delim2;
  if (!rawPath || !rawDelim) {
    return null;
  }

  const delimiter = stripShellQuotes(rawDelim);
  if (!delimiter) {
    return null;
  }

  return { path: stripShellQuotes(rawPath), delimiter };
}

function validateScopedSegments(
  command: string,
  cwd: string | null,
  allowedRoots: string[],
  env: NodeJS.ProcessEnv,
  shellVars: ScopedShellVars,
): { safe: boolean; cwd: string | null } {
  const scopedCommand = rewriteScopedMemoryRedirects(
    command,
    cwd,
    allowedRoots,
    env,
    shellVars,
  );
  if (!scopedCommand) {
    return { safe: false, cwd };
  }

  const segments = splitShellSegments(scopedCommand);
  if (!segments || segments.length === 0) {
    return { safe: false, cwd };
  }

  let nextCwd: string | null = cwd;
  for (const segment of segments) {
    const result = isAllowedMemorySegment(
      segment,
      nextCwd,
      allowedRoots,
      env,
      shellVars,
    );
    if (!result.safe) {
      return { safe: false, cwd: nextCwd };
    }
    nextCwd = result.nextCwd;
  }

  return { safe: true, cwd: nextCwd };
}

function isScopedHeredocMemoryCommand(
  command: string,
  initialCwd: string | null,
  allowedRoots: string[],
  env: NodeJS.ProcessEnv,
  shellVars: ScopedShellVars,
): boolean | null {
  const lines = command.split(/\r?\n/);
  const firstLine = lines[0]?.trim() ?? "";
  if (!firstLine) {
    return null;
  }

  const firstLineSegments = splitShellSegmentsAllowUnsafeRedirects(firstLine);
  if (!firstLineSegments) {
    return false;
  }

  const heredocIndex = firstLineSegments.findIndex((segment) =>
    Boolean(extractHeredocWrite(segment)),
  );
  if (heredocIndex === -1) {
    return null;
  }

  if (firstLineSegments.slice(heredocIndex + 1).length > 0) {
    return false;
  }

  let cwd: string | null = initialCwd;
  if (heredocIndex > 0) {
    const prefixResult = validateScopedSegments(
      firstLineSegments.slice(0, heredocIndex).join(" && "),
      cwd,
      allowedRoots,
      env,
      shellVars,
    );
    if (!prefixResult.safe) {
      return false;
    }
    cwd = prefixResult.cwd;
  }

  const heredoc = extractHeredocWrite(firstLineSegments[heredocIndex] ?? "");
  if (!heredoc) {
    return false;
  }

  const resolved = normalizeScopePath(heredoc.path, cwd, env, shellVars);
  if (!resolved || !isPathWithinRoots(resolved, allowedRoots)) {
    return false;
  }

  let terminatorLine = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if ((lines[i] ?? "") === heredoc.delimiter) {
      terminatorLine = i;
      break;
    }
  }
  if (terminatorLine === -1) {
    return false;
  }

  const trailingCommand = lines
    .slice(terminatorLine + 1)
    .join("\n")
    .trim();
  if (trailingCommand) {
    const trailingResult = validateScopedSegments(
      trailingCommand,
      cwd,
      allowedRoots,
      env,
      shellVars,
    );
    if (!trailingResult.safe) {
      return false;
    }
  }

  return true;
}

function isReadOnlyGhApiInvocation(args: string[]): boolean {
  let method = "GET";

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg) {
      continue;
    }

    if (arg === "-X" || arg === "--method") {
      const next = args[i + 1];
      if (!next) {
        return false;
      }
      method = next.toUpperCase();
      i += 1;
      continue;
    }

    if (arg.startsWith("--method=")) {
      method = arg.slice("--method=".length).toUpperCase();
      continue;
    }

    if (arg.startsWith("-X") && arg.length > 2) {
      method = arg.slice(2).toUpperCase();
      continue;
    }

    if (
      arg === "-f" ||
      arg === "-F" ||
      arg === "--field" ||
      arg === "--raw-field" ||
      arg === "--input" ||
      arg.startsWith("--field=") ||
      arg.startsWith("--raw-field=") ||
      arg.startsWith("--input=")
    ) {
      return false;
    }
  }

  return method === "GET" || method === "HEAD";
}

export interface ReadOnlyShellOptions {
  allowExternalPaths?: boolean;
  allowedPathRoots?: string[];
}

export function isReadOnlyShellCommand(
  command: string | string[] | undefined | null,
  options: ReadOnlyShellOptions = {},
): boolean {
  if (!command) {
    return false;
  }

  if (Array.isArray(command)) {
    if (command.length === 0) {
      return false;
    }
    const joined = command.join(" ");
    const [executable, ...rest] = command;
    if (executable && isShellExecutor(executable)) {
      const nested = extractDashCArgument(rest);
      if (!nested) {
        return false;
      }
      return isReadOnlyShellCommand(nested, options);
    }
    return isReadOnlyShellCommand(joined, options);
  }

  const trimmed = command.trim();
  if (!trimmed) {
    return false;
  }

  const nodes = parseShellAnalysis(trimmed);
  if (!nodes || nodes.length === 0) {
    return false;
  }

  return areReadOnlyNodes(nodes, options);
}

function isSafeSegment(
  segment: string,
  options: ReadOnlyShellOptions,
): boolean {
  const tokens = tokenizeShellWords(segment);
  if (tokens.length === 0) {
    return false;
  }

  const command = tokens[0];
  if (!command) {
    return false;
  }
  if (isShellExecutor(command)) {
    const nested = extractDashCArgument(tokens.slice(1));
    if (!nested) {
      return false;
    }
    return isReadOnlyShellCommand(stripShellQuotes(nested), options);
  }

  if (command === "env") {
    return isSafeEnvInvocation(tokens, options);
  }

  if (command === "rg" && hasUnsafeRipgrepOptions(tokens)) {
    return false;
  }

  if (ALWAYS_SAFE_COMMANDS.has(command)) {
    if (command === "cd") {
      if (options.allowExternalPaths) {
        return true;
      }
      return !tokens.slice(1).some((t) => hasDisallowedPathArg(t, options));
    }

    if (EXTERNAL_PATH_METADATA_COMMANDS.has(command)) {
      return true;
    }

    const hasExternalPath =
      !options.allowExternalPaths &&
      tokens.slice(1).some((t) => hasDisallowedPathArg(t, options));

    if (hasExternalPath) {
      return false;
    }
    return true;
  }

  if (command === "sed") {
    const usesInPlace = tokens.some(
      (token) =>
        token === "-i" || token.startsWith("-i") || token === "--in-place",
    );
    if (usesInPlace) {
      return false;
    }

    const hasExternalPath =
      !options.allowExternalPaths &&
      tokens.slice(1).some((t) => hasDisallowedPathArg(t, options));

    if (hasExternalPath) {
      return false;
    }
    return true;
  }

  if (command === "git") {
    const { subcommand, subcommandIndex, isSafePath } = parseGitInvocation(
      tokens,
      options,
    );
    if (!isSafePath) {
      return false;
    }
    if (!subcommand) {
      return false;
    }
    if (hasUnsafeGitFlags(tokens)) {
      return false;
    }
    if (!SAFE_GIT_SUBCOMMANDS.has(subcommand)) {
      return false;
    }
    if (subcommand === "grep") {
      return isReadOnlyGitGrepArgs(tokens.slice(subcommandIndex + 1), options);
    }
    if (subcommand === "branch") {
      return isReadOnlyGitBranchArgs(tokens.slice(subcommandIndex + 1));
    }
    return true;
  }

  if (command === "gh") {
    const category = tokens[1];
    if (!category) {
      return false;
    }
    if (!(category in SAFE_GH_COMMANDS)) {
      return false;
    }
    const allowedActions = SAFE_GH_COMMANDS[category];
    if (allowedActions === null) {
      if (category === "api") {
        return isReadOnlyGhApiInvocation(tokens.slice(2));
      }
      return true;
    }
    if (allowedActions === undefined) {
      return false;
    }
    const action = tokens[2];
    if (!action) {
      return false;
    }
    return allowedActions.has(action);
  }

  if (command === "letta") {
    const group = tokens[1];
    if (!group) {
      return false;
    }
    if (!(group in SAFE_LETTA_COMMANDS)) {
      return false;
    }
    const action = tokens[2];
    if (!action) {
      return false;
    }
    return SAFE_LETTA_COMMANDS[group]?.has(action) ?? false;
  }

  if (command === "find") {
    return isSafeFindInvocation(tokens);
  }
  if (command === "sort") {
    return !/\s-o\b/.test(segment);
  }
  return false;
}

function isAbsolutePathArg(value: string): boolean {
  if (!value) {
    return false;
  }

  if (value.startsWith("/")) {
    return true;
  }

  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

function isHomeAnchoredPathArg(value: string): boolean {
  if (!value) {
    return false;
  }

  return (
    value.startsWith("~/") ||
    value.startsWith("$HOME/") ||
    value.startsWith("%USERPROFILE%\\") ||
    value.startsWith("%USERPROFILE%/")
  );
}

function isUnderAllowedPathRoot(
  value: string,
  allowedPathRoots?: string[],
): boolean {
  if (!allowedPathRoots || allowedPathRoots.length === 0) {
    return false;
  }

  const resolvedValue = expandPath(value);
  return allowedPathRoots.some((root) => {
    const normalizedRoot = normalizeSeparators(resolve(root));
    return (
      resolvedValue === normalizedRoot ||
      resolvedValue.startsWith(`${normalizedRoot}/`)
    );
  });
}

function hasDisallowedPathArg(
  value: string,
  options: ReadOnlyShellOptions,
): boolean {
  if (!hasAbsoluteOrTraversalPathArg(value)) {
    return false;
  }

  if (options.allowExternalPaths) {
    return false;
  }

  if (isAbsolutePathArg(value) || isHomeAnchoredPathArg(value)) {
    return !isUnderAllowedPathRoot(value, options.allowedPathRoots);
  }

  return true;
}

function hasAbsoluteOrTraversalPathArg(value: string): boolean {
  if (isAbsolutePathArg(value) || isHomeAnchoredPathArg(value)) {
    return true;
  }

  return /(^|[\\/])\.\.([\\/]|$)/.test(value);
}

function parseGitInvocation(
  tokens: string[],
  options: ReadOnlyShellOptions,
): { subcommand: string | null; subcommandIndex: number; isSafePath: boolean } {
  let index = 1;

  while (index < tokens.length) {
    const token = tokens[index];
    if (!token) {
      index += 1;
      continue;
    }

    if (token === "-C") {
      const pathToken = tokens[index + 1];
      if (!pathToken || hasDisallowedPathArg(pathToken, options)) {
        return { subcommand: null, subcommandIndex: -1, isSafePath: false };
      }
      index += 2;
      continue;
    }

    return { subcommand: token, subcommandIndex: index, isSafePath: true };
  }

  return { subcommand: null, subcommandIndex: -1, isSafePath: true };
}

function getAllowedMemoryPrefixes(agentId: string): string[] {
  const home = homedir();
  const prefixes: string[] = [
    normalizeSeparators(resolve(home, ".letta", "agents", agentId, "memory")),
    normalizeSeparators(
      resolve(home, ".letta", "agents", agentId, "memory-worktrees"),
    ),
  ];
  const parentId = process.env.LETTA_PARENT_AGENT_ID;
  if (parentId && parentId !== agentId) {
    prefixes.push(
      normalizeSeparators(
        resolve(home, ".letta", "agents", parentId, "memory"),
      ),
      normalizeSeparators(
        resolve(home, ".letta", "agents", parentId, "memory-worktrees"),
      ),
    );
  }
  return prefixes;
}

function normalizeSeparators(p: string): string {
  return p.replace(/\\/g, "/");
}

function expandPath(p: string): string {
  return normalizeMemoryPath(p);
}

type ScopedShellOptions = {
  env?: NodeJS.ProcessEnv;
  workingDirectory?: string;
};

type ScopedShellVars = Record<string, string>;

function expandScopedVariables(
  value: string,
  env: NodeJS.ProcessEnv,
  shellVars: ScopedShellVars,
): string | null {
  let unresolved = false;
  const expanded = value.replace(
    /\$(?:{([A-Za-z_][A-Za-z0-9_]*)}|([A-Za-z_][A-Za-z0-9_]*))/g,
    (_match, bracedName: string | undefined, bareName: string | undefined) => {
      const name = bracedName || bareName;
      if (!name) {
        unresolved = true;
        return "";
      }

      if (name === "HOME") {
        return homedir();
      }

      const scopedValue = shellVars[name];
      if (typeof scopedValue === "string") {
        return scopedValue;
      }

      const envValue = env[name];
      if (typeof envValue === "string") {
        return envValue;
      }

      unresolved = true;
      return "";
    },
  );

  return unresolved ? null : expanded;
}

function normalizeScopePath(
  path: string,
  cwd: string | null,
  env: NodeJS.ProcessEnv,
  shellVars: ScopedShellVars,
): string | null {
  const expandedPath = expandScopedVariables(path, env, shellVars);
  if (!expandedPath) {
    return null;
  }

  if (
    expandedPath.startsWith("~/") ||
    expandedPath.startsWith("$HOME/") ||
    expandedPath.startsWith('"$HOME/') ||
    expandedPath.startsWith("/") ||
    /^[a-zA-Z]:[\\/]/.test(expandedPath)
  ) {
    return normalizeMemoryPath(expandedPath);
  }

  if (cwd) {
    return normalizeMemoryPath(resolve(cwd, expandedPath));
  }

  return null;
}

function parseScopedAssignmentToken(
  token: string,
): { name: string; value: string } | null {
  const match = token.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (!match) {
    return null;
  }

  return {
    name: match[1] ?? "",
    value: stripShellQuotes(match[2] ?? ""),
  };
}

function applyScopedAssignments(
  tokens: string[],
  env: NodeJS.ProcessEnv,
  shellVars: ScopedShellVars,
): boolean {
  if (tokens.length === 0) {
    return false;
  }

  for (const token of tokens) {
    const assignment = parseScopedAssignmentToken(token);
    if (!assignment) {
      return false;
    }

    const expandedValue = expandScopedVariables(
      assignment.value,
      env,
      shellVars,
    );
    if (expandedValue === null) {
      return false;
    }

    if (
      expandedValue.startsWith("~/") ||
      expandedValue.startsWith("$HOME/") ||
      expandedValue.startsWith('"$HOME/') ||
      expandedValue.startsWith("/") ||
      /^[a-zA-Z]:[\\/]/.test(expandedValue)
    ) {
      shellVars[assignment.name] = normalizeMemoryPath(expandedValue);
    } else {
      shellVars[assignment.name] = expandedValue;
    }
  }

  return true;
}

function hasUnsafeRebaseOption(tokens: string[], startIndex: number): boolean {
  for (let i = startIndex; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token) {
      continue;
    }
    const lower = token.toLowerCase();

    if (
      lower === "--exec" ||
      lower.startsWith("--exec=") ||
      lower === "-x" ||
      (lower.startsWith("-x") && lower.length > 2) ||
      lower === "--interactive" ||
      lower === "-i" ||
      lower === "--edit-todo"
    ) {
      return true;
    }
  }

  return false;
}

function isSafeMemoryGitConfig(tokens: string[], startIndex: number): boolean {
  const args = tokens.slice(startIndex);
  // Memory git config is allowed except for scopes that write outside the
  // memory repo.
  return !args.some((arg) => {
    const lower = arg.toLowerCase();
    return lower === "--global" || lower === "--system";
  });
}

function isSafeMemoryGitFetch(tokens: string[], startIndex: number): boolean {
  // Permit fetching from configured remotes, but not arbitrary URL/refspecs.
  const allowedFlags = new Set(["--prune", "--tags", "--quiet", "-q"]);
  const args = tokens.slice(startIndex);
  if (args.length === 0) {
    return true;
  }

  let remoteCount = 0;
  for (const arg of args) {
    if (allowedFlags.has(arg)) {
      continue;
    }
    if (arg.startsWith("-")) {
      return false;
    }
    // Remote names are local config aliases (usually "origin"). Disallow
    // URL-like or path-like values so memory commands cannot fetch arbitrary URLs.
    if (!/^[A-Za-z0-9._-]+$/.test(arg)) {
      return false;
    }
    remoteCount += 1;
    if (remoteCount > 1) {
      return false;
    }
  }

  return true;
}

function isSafeMemoryGitShowRef(tokens: string[], startIndex: number): boolean {
  // Keep this intentionally narrow; the observed rollout need is plain
  // `git show-ref` for local ref introspection.
  return tokens.length === startIndex;
}

function isSafeMemoryGitCheckIgnore(
  tokens: string[],
  startIndex: number,
  cwd: string | null,
  allowedRoots: string[],
  env: NodeJS.ProcessEnv,
  shellVars: ScopedShellVars,
): boolean {
  const allowedFlags = new Set(["-v", "--verbose", "-q", "--quiet"]);
  const paths: string[] = [];

  for (let i = startIndex; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token) {
      continue;
    }
    if (allowedFlags.has(token)) {
      continue;
    }
    if (token === "--") {
      continue;
    }
    if (token.startsWith("-")) {
      return false;
    }
    paths.push(token);
  }

  if (paths.length === 0) {
    return false;
  }

  return paths.every((pathToken) => {
    const resolved = normalizeScopePath(pathToken, cwd, env, shellVars);
    return resolved ? isPathWithinRoots(resolved, allowedRoots) : false;
  });
}

function isSafeMemoryGitRestore(
  tokens: string[],
  startIndex: number,
  cwd: string | null,
  allowedRoots: string[],
  env: NodeJS.ProcessEnv,
  shellVars: ScopedShellVars,
): boolean {
  let sawStaged = false;
  const paths: string[] = [];

  for (let i = startIndex; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token) {
      continue;
    }
    if (token === "--staged") {
      sawStaged = true;
      continue;
    }
    if (token === "--") {
      continue;
    }
    if (token.startsWith("-")) {
      return false;
    }
    paths.push(token);
  }

  if (!sawStaged || paths.length === 0) {
    return false;
  }

  return paths.every((pathToken) => {
    const resolved = normalizeScopePath(pathToken, cwd, env, shellVars);
    return resolved ? isPathWithinRoots(resolved, allowedRoots) : false;
  });
}

function parseScopedGitInvocation(
  tokens: string[],
  cwd: string | null,
  allowedRoots: string[],
  env: NodeJS.ProcessEnv,
  shellVars: ScopedShellVars,
): {
  subcommand: string | null;
  worktreeSubcommand: string | null;
  resolvedCwd: string | null;
  isSafe: boolean;
} {
  let index = 1;
  let resolvedCwd = cwd;

  while (index < tokens.length) {
    const token = tokens[index];
    if (!token) {
      index += 1;
      continue;
    }

    if (token === "-C") {
      const pathToken = tokens[index + 1];
      if (!pathToken) {
        return {
          subcommand: null,
          worktreeSubcommand: null,
          resolvedCwd,
          isSafe: false,
        };
      }
      const nextCwd = normalizeScopePath(
        pathToken,
        resolvedCwd,
        env,
        shellVars,
      );
      if (!nextCwd || !isPathWithinRoots(nextCwd, allowedRoots)) {
        return {
          subcommand: null,
          worktreeSubcommand: null,
          resolvedCwd,
          isSafe: false,
        };
      }
      resolvedCwd = nextCwd;
      index += 2;
      continue;
    }

    if (token === "-c") {
      const configToken = tokens[index + 1];
      if (!configToken) {
        return {
          subcommand: null,
          worktreeSubcommand: null,
          resolvedCwd,
          isSafe: false,
        };
      }
      if (!/^http\.extraHeader=/.test(configToken)) {
        return {
          subcommand: null,
          worktreeSubcommand: null,
          resolvedCwd,
          isSafe: false,
        };
      }
      index += 2;
      continue;
    }

    const subcommand = token;
    if (!SAFE_MEMORY_GIT_SUBCOMMANDS.has(subcommand)) {
      if (resolvedCwd && SAFE_MEMORY_COMMANDS.has("git")) {
        const rawSegment = tokens.join(" ");
        if (subcommand === "ls-tree" && !/\s-o\b/.test(rawSegment)) {
          return {
            subcommand,
            worktreeSubcommand: null,
            resolvedCwd,
            isSafe: true,
          };
        }
      }
      return {
        subcommand,
        worktreeSubcommand: null,
        resolvedCwd,
        isSafe: false,
      };
    }

    const worktreeSubcommand =
      subcommand === "worktree" ? (tokens[index + 1] ?? null) : null;
    if (
      subcommand === "worktree" &&
      worktreeSubcommand &&
      !new Set(["add", "remove", "list"]).has(worktreeSubcommand)
    ) {
      return {
        subcommand,
        worktreeSubcommand,
        resolvedCwd,
        isSafe: false,
      };
    }

    if (subcommand === "rebase" && hasUnsafeRebaseOption(tokens, index + 1)) {
      return {
        subcommand,
        worktreeSubcommand,
        resolvedCwd,
        isSafe: false,
      };
    }

    if (subcommand === "config" && !isSafeMemoryGitConfig(tokens, index + 1)) {
      return {
        subcommand,
        worktreeSubcommand,
        resolvedCwd,
        isSafe: false,
      };
    }

    if (subcommand === "fetch" && !isSafeMemoryGitFetch(tokens, index + 1)) {
      return {
        subcommand,
        worktreeSubcommand,
        resolvedCwd,
        isSafe: false,
      };
    }

    if (
      subcommand === "show-ref" &&
      !isSafeMemoryGitShowRef(tokens, index + 1)
    ) {
      return {
        subcommand,
        worktreeSubcommand,
        resolvedCwd,
        isSafe: false,
      };
    }

    if (
      subcommand === "check-ignore" &&
      !isSafeMemoryGitCheckIgnore(
        tokens,
        index + 1,
        resolvedCwd,
        allowedRoots,
        env,
        shellVars,
      )
    ) {
      return {
        subcommand,
        worktreeSubcommand,
        resolvedCwd,
        isSafe: false,
      };
    }

    if (
      subcommand === "restore" &&
      !isSafeMemoryGitRestore(
        tokens,
        index + 1,
        resolvedCwd,
        allowedRoots,
        env,
        shellVars,
      )
    ) {
      return {
        subcommand,
        worktreeSubcommand,
        resolvedCwd,
        isSafe: false,
      };
    }

    return { subcommand, worktreeSubcommand, resolvedCwd, isSafe: true };
  }

  return {
    subcommand: null,
    worktreeSubcommand: null,
    resolvedCwd,
    isSafe: false,
  };
}

function tokenLooksLikePath(token: string): boolean {
  return (
    token.includes("/") ||
    token.includes("\\") ||
    token === "." ||
    token === ".." ||
    token.startsWith("$") ||
    token.startsWith("~") ||
    token.startsWith("$HOME")
  );
}

function validateScopedTokens(
  tokens: string[],
  cwd: string | null,
  allowedRoots: string[],
  env: NodeJS.ProcessEnv,
  shellVars: ScopedShellVars,
): boolean {
  return tokens.every((token, index) => {
    if (!tokenLooksLikePath(token)) {
      return true;
    }

    const previous = index > 0 ? tokens[index - 1] : null;
    if (
      previous &&
      ["-m", "--message", "--author", "--format"].includes(previous)
    ) {
      return true;
    }

    const resolved = normalizeScopePath(token, cwd, env, shellVars);
    return resolved ? isPathWithinRoots(resolved, allowedRoots) : false;
  });
}

function isAllowedMemorySegment(
  segment: string,
  cwd: string | null,
  allowedRoots: string[],
  env: NodeJS.ProcessEnv,
  shellVars: ScopedShellVars,
): { nextCwd: string | null; safe: boolean } {
  const tokens = tokenizeShellWords(segment);
  if (tokens.length === 0) {
    return { nextCwd: cwd, safe: false };
  }

  if (applyScopedAssignments(tokens, env, shellVars)) {
    return { nextCwd: cwd, safe: true };
  }

  const command = tokens[0];
  if (!command) {
    return { nextCwd: cwd, safe: false };
  }

  if (command === "cd") {
    const target = tokens[1];
    if (!target) {
      return { nextCwd: cwd, safe: false };
    }
    const resolved = normalizeScopePath(target, cwd, env, shellVars);
    return {
      nextCwd: resolved,
      safe: resolved ? isPathWithinRoots(resolved, allowedRoots) : false,
    };
  }

  if (!SAFE_MEMORY_COMMANDS.has(command)) {
    return { nextCwd: cwd, safe: false };
  }

  if (command === "git") {
    const parsed = parseScopedGitInvocation(
      tokens,
      cwd,
      allowedRoots,
      env,
      shellVars,
    );
    if (!parsed.isSafe) {
      return { nextCwd: parsed.resolvedCwd, safe: false };
    }

    const effectiveCwd = parsed.resolvedCwd;
    if (!effectiveCwd || !isPathWithinRoots(effectiveCwd, allowedRoots)) {
      return { nextCwd: effectiveCwd, safe: false };
    }

    if (
      !validateScopedTokens(tokens, effectiveCwd, allowedRoots, env, shellVars)
    ) {
      return { nextCwd: effectiveCwd, safe: false };
    }

    return { nextCwd: effectiveCwd, safe: true };
  }

  if (tokens.some((token) => tokenLooksLikePath(token))) {
    if (
      !validateScopedTokens(tokens.slice(1), cwd, allowedRoots, env, shellVars)
    ) {
      return { nextCwd: cwd, safe: false };
    }
    return { nextCwd: cwd, safe: true };
  }

  if (!cwd || !isPathWithinRoots(cwd, allowedRoots)) {
    return { nextCwd: cwd, safe: false };
  }

  if (command === "find" && !isSafeFindInvocation(tokens)) {
    return { nextCwd: cwd, safe: false };
  }

  if (command === "sort" && /\s-o\b/.test(segment)) {
    return { nextCwd: cwd, safe: false };
  }

  if (
    !validateScopedTokens(tokens.slice(1), cwd, allowedRoots, env, shellVars)
  ) {
    return { nextCwd: cwd, safe: false };
  }

  return { nextCwd: cwd, safe: true };
}

export function isScopedMemoryShellCommand(
  command: string | string[] | undefined | null,
  allowedRoots: string[],
  options: ScopedShellOptions = {},
): boolean {
  if (!command || allowedRoots.length === 0) {
    return false;
  }

  if (Array.isArray(command)) {
    if (command.length === 0) {
      return false;
    }
    const [executable, ...rest] = command;
    if (executable && isShellExecutor(executable)) {
      const nested = extractDashCArgument(rest);
      if (!nested) {
        return false;
      }
      return isScopedMemoryShellCommand(
        stripShellQuotes(nested),
        allowedRoots,
        options,
      );
    }
  }

  const commandStr = typeof command === "string" ? command : command.join(" ");
  const trimmed = commandStr.trim();
  if (!trimmed) {
    return false;
  }

  const env = options.env ?? process.env;
  const shellVars: ScopedShellVars = {};
  const initialCwd = options.workingDirectory
    ? normalizeScopePath(options.workingDirectory, null, env, shellVars)
    : null;

  if (trimmed.includes("<<")) {
    const heredocResult = isScopedHeredocMemoryCommand(
      trimmed,
      initialCwd,
      allowedRoots,
      env,
      shellVars,
    );
    if (heredocResult !== null) {
      return heredocResult;
    }
  }

  return validateScopedSegments(
    trimmed,
    initialCwd,
    allowedRoots,
    env,
    shellVars,
  ).safe;
}

/**
 * Check if a shell command exclusively targets the agent's memory directory.
 */
export function isMemoryDirCommand(
  command: string | string[] | undefined | null,
  agentId: string,
): boolean {
  if (!command || !agentId) {
    return false;
  }

  return isScopedMemoryShellCommand(command, getAllowedMemoryPrefixes(agentId));
}
