import { homedir } from "node:os";
import { resolve } from "node:path";

/**
 * When true, ANY command scoped entirely to the agent's memory directory is auto-approved.
 * When false, only git + safe file operations are auto-approved in the memory dir.
 */
const MEMORY_DIR_APPROVE_ALL = true;

/** Commands allowed in memory dir when MEMORY_DIR_APPROVE_ALL is false */
const SAFE_MEMORY_DIR_COMMANDS = new Set([
  "git",
  "rm",
  "mv",
  "mkdir",
  "cp",
  "ls",
  "cat",
  "head",
  "tail",
  "tree",
  "find",
  "wc",
  "split",
  "echo",
  "sort",
  "cd",
]);

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
  "env",
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
]);

const SAFE_GIT_SUBCOMMANDS = new Set([
  "status",
  "diff",
  "log",
  "show",
  "branch",
  "tag",
  "remote",
]);

// letta CLI read-only subcommands: group -> allowed actions
const SAFE_LETTA_COMMANDS: Record<string, Set<string>> = {
  memfs: new Set(["status", "help", "backups", "export"]),
  agents: new Set(["list", "help"]),
  messages: new Set(["search", "list", "help"]),
  blocks: new Set(["list", "help"]),
};

// gh CLI read-only commands: category -> allowed actions
// null means any action is allowed for that category
const SAFE_GH_COMMANDS: Record<string, Set<string> | null> = {
  pr: new Set(["list", "status", "checks", "diff", "view"]),
  issue: new Set(["list", "status", "view"]),
  repo: new Set(["list", "view", "gitignore", "license"]),
  run: new Set(["list", "view", "watch", "download"]),
  release: new Set(["list", "view", "download"]),
  search: null, // all search subcommands are read-only
  api: null, // usually GET requests for exploration
  status: null, // top-level command, no action needed
};

/**
 * Split a shell command into segments on unquoted separators: |, &&, ||, ;
 * Returns null if dangerous operators are found:
 * - redirects (>, >>) outside quotes
 * - command substitution ($(), backticks) outside single quotes
 */
function splitShellSegments(input: string): string[] | null {
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

      // Command substitution still evaluates inside double quotes.
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

    if (input.startsWith(">>", i) || ch === ">") {
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

export interface ReadOnlyShellOptions {
  /**
   * Allow absolute/home/traversal path arguments for read-only commands.
   * Used in plan mode where read-only shell should not be restricted to cwd-relative paths.
   */
  allowExternalPaths?: boolean;
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

  const segments = splitShellSegments(trimmed);
  if (!segments || segments.length === 0) {
    return false;
  }

  for (const segment of segments) {
    if (!isSafeSegment(segment, options)) {
      return false;
    }
  }

  return true;
}

function isSafeSegment(
  segment: string,
  options: ReadOnlyShellOptions,
): boolean {
  const tokens = tokenize(segment);
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
    return isReadOnlyShellCommand(stripQuotes(nested), options);
  }

  if (ALWAYS_SAFE_COMMANDS.has(command)) {
    // `cd` is read-only, but it should still respect path restrictions so
    // `cd / && cat relative/path` cannot bypass path checks on later segments.
    if (command === "cd") {
      if (options.allowExternalPaths) {
        return true;
      }
      return !tokens.slice(1).some((t) => hasAbsoluteOrTraversalPathArg(t));
    }

    // For other "always safe" commands, ensure they don't read sensitive files
    // outside the allowed directories.
    const hasExternalPath =
      !options.allowExternalPaths &&
      tokens.slice(1).some((t) => hasAbsoluteOrTraversalPathArg(t));

    if (hasExternalPath) {
      return false;
    }
    return true;
  }

  if (command === "sed") {
    // sed is read-only unless in-place edit flags are used.
    const usesInPlace = tokens.some(
      (token) =>
        token === "-i" || token.startsWith("-i") || token === "--in-place",
    );
    if (usesInPlace) {
      return false;
    }

    const hasExternalPath =
      !options.allowExternalPaths &&
      tokens.slice(1).some((t) => hasAbsoluteOrTraversalPathArg(t));

    if (hasExternalPath) {
      return false;
    }
    return true;
  }

  if (command === "git") {
    const subcommand = tokens[1];
    if (!subcommand) {
      return false;
    }
    return SAFE_GIT_SUBCOMMANDS.has(subcommand);
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
    // null means any action is allowed (e.g., gh search, gh api, gh status)
    if (allowedActions === null) {
      return true;
    }
    // undefined means category not in map (shouldn't happen after 'in' check)
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
    return !/-delete|\s-exec\b/.test(segment);
  }
  if (command === "sort") {
    return !/\s-o\b/.test(segment);
  }
  return false;
}

function isShellExecutor(command: string): boolean {
  return command === "bash" || command === "sh";
}

function tokenize(segment: string): string[] {
  const matches = segment.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g);
  if (!matches) {
    return [];
  }
  return matches.map((token) => stripQuotes(token));
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function extractDashCArgument(tokens: string[]): string | undefined {
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

function isAbsolutePathArg(value: string): boolean {
  if (!value) {
    return false;
  }

  // POSIX absolute paths
  if (value.startsWith("/")) {
    return true;
  }

  // Windows absolute paths (drive letter and UNC)
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

function hasAbsoluteOrTraversalPathArg(value: string): boolean {
  if (isAbsolutePathArg(value) || isHomeAnchoredPathArg(value)) {
    return true;
  }

  // Path traversal segments only
  return /(^|[\\/])\.\.([\\/]|$)/.test(value);
}

/**
 * Build the set of allowed memory directory prefixes for the current agent.
 * Includes:
 * - ~/.letta/agents/<agentId>/memory/
 * - ~/.letta/agents/<agentId>/memory-worktrees/
 * And if LETTA_PARENT_AGENT_ID is set (subagent context):
 * - ~/.letta/agents/<parentAgentId>/memory/
 * - ~/.letta/agents/<parentAgentId>/memory-worktrees/
 */
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

/**
 * Normalize a path to forward slashes (for consistent comparison on Windows).
 */
function normalizeSeparators(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Resolve a path that may contain ~ or $HOME to an absolute path.
 * Always returns forward slashes for cross-platform consistency.
 */
function expandPath(p: string): string {
  const home = homedir();
  if (p.startsWith("~/")) {
    return normalizeSeparators(resolve(home, p.slice(2)));
  }
  if (p.startsWith("$HOME/")) {
    return normalizeSeparators(resolve(home, p.slice(6)));
  }
  if (p.startsWith('"$HOME/')) {
    return normalizeSeparators(resolve(home, p.slice(7).replace(/"$/, "")));
  }
  return normalizeSeparators(resolve(p));
}

/**
 * Check if a path falls within any of the allowed memory directory prefixes.
 */
function isUnderMemoryDir(path: string, prefixes: string[]): boolean {
  const resolved = expandPath(path);
  return prefixes.some(
    (prefix) => resolved === prefix || resolved.startsWith(`${prefix}/`),
  );
}

/**
 * Extract the working directory from a command that starts with `cd <path>`.
 * Returns null if the command doesn't start with cd.
 */
function extractCdTarget(segment: string): string | null {
  const tokens = tokenize(segment);
  if (tokens[0] === "cd" && tokens[1]) {
    return tokens[1];
  }
  return null;
}

/**
 * Check if a shell command exclusively targets the agent's memory directory.
 *
 * Unlike isReadOnlyShellCommand, this allows WRITE operations (git commit, rm, etc.)
 * but only when all paths in the command resolve to the agent's own memory dir.
 *
 * @param command - The shell command string
 * @param agentId - The current agent's ID
 * @returns true if the command should be auto-approved as a memory dir operation
 */
export function isMemoryDirCommand(
  command: string | string[] | undefined | null,
  agentId: string,
): boolean {
  if (!command || !agentId) {
    return false;
  }

  const commandStr = typeof command === "string" ? command : command.join(" ");
  const trimmed = commandStr.trim();
  if (!trimmed) {
    return false;
  }

  const prefixes = getAllowedMemoryPrefixes(agentId);

  // Split on && || ; to get individual command segments.
  // We intentionally do NOT reject $() or > here — those are valid
  // in memory dir commands (e.g. git push with auth header, echo > file).
  const segments = trimmed
    .split(/&&|\|\||;/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (segments.length === 0) {
    return false;
  }

  // Track the current working directory through the chain.
  // If first segment is `cd <memory-dir>`, subsequent commands inherit that context.
  let cwd: string | null = null;

  for (const segment of segments) {
    // Handle pipe chains: split on | and check each part
    const pipeParts = segment
      .split(/\|/)
      .map((s) => s.trim())
      .filter(Boolean);

    for (const part of pipeParts) {
      const cdTarget = extractCdTarget(part);
      if (cdTarget) {
        // This is a cd command — check if it targets memory dir
        const resolved: string = cwd
          ? expandPath(resolve(expandPath(cwd), cdTarget))
          : expandPath(cdTarget);
        if (!isUnderMemoryDir(resolved, prefixes)) {
          return false;
        }
        cwd = resolved;
        continue;
      }

      // For non-cd commands, check if we have a memory dir cwd
      // OR if all path-like arguments point to the memory dir
      if (cwd && isUnderMemoryDir(cwd, prefixes)) {
        // We're operating within the memory dir
        const tokens = tokenize(part);

        const currentCwd = cwd;
        if (!currentCwd) {
          return false;
        }

        // Even if we're in the memory dir, we must ensure the command doesn't
        // escape it via absolute paths or parent directory references.
        const hasExternalPath = tokens.some((t) => {
          if (isAbsolutePathArg(t) || isHomeAnchoredPathArg(t)) {
            return !isUnderMemoryDir(t, prefixes);
          }

          if (hasAbsoluteOrTraversalPathArg(t)) {
            const resolved = expandPath(resolve(expandPath(currentCwd), t));
            return !isUnderMemoryDir(resolved, prefixes);
          }

          return false;
        });

        if (hasExternalPath) {
          return false;
        }

        if (!MEMORY_DIR_APPROVE_ALL) {
          // Strict mode: validate command type
          const cmd = tokens[0];
          if (!cmd || !SAFE_MEMORY_DIR_COMMANDS.has(cmd)) {
            return false;
          }
        }
        continue;
      }

      // No cd context — check if the command itself references memory dir paths
      const tokens = tokenize(part);
      const hasMemoryPath = tokens.some(
        (t) =>
          (t.includes(".letta/agents/") && t.includes("/memory")) ||
          (t.includes(".letta/agents/") && t.includes("/memory-worktrees")),
      );

      if (hasMemoryPath) {
        // Verify ALL path-like tokens that reference .letta/agents/ are within allowed prefixes
        const agentPaths = tokens.filter((t) => t.includes(".letta/agents/"));
        if (agentPaths.every((p) => isUnderMemoryDir(p, prefixes))) {
          if (!MEMORY_DIR_APPROVE_ALL) {
            const cmd = tokens[0];
            if (!cmd || !SAFE_MEMORY_DIR_COMMANDS.has(cmd)) {
              return false;
            }
          }
          continue;
        }
      }

      // This segment doesn't target memory dir and we're not in a memory dir cwd
      return false;
    }
  }

  return true;
}
