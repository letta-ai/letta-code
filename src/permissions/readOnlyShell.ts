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

// Operators that are always dangerous (file redirects, command substitution)
// Note: &&, ||, ; are handled by splitting and checking each segment
const DANGEROUS_OPERATOR_PATTERN = /(>>|>|\$\(|`)/;

export function isReadOnlyShellCommand(
  command: string | string[] | undefined | null,
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
      return isReadOnlyShellCommand(nested);
    }
    return isReadOnlyShellCommand(joined);
  }

  const trimmed = command.trim();
  if (!trimmed) {
    return false;
  }

  if (DANGEROUS_OPERATOR_PATTERN.test(trimmed)) {
    return false;
  }

  // Split on command separators: |, &&, ||, ;
  // Each segment must be safe for the whole command to be safe
  const segments = trimmed
    .split(/\||&&|\|\||;/)
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (segments.length === 0) {
    return false;
  }

  for (const segment of segments) {
    if (!isSafeSegment(segment)) {
      return false;
    }
  }

  return true;
}

function isSafeSegment(segment: string): boolean {
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
    return isReadOnlyShellCommand(stripQuotes(nested));
  }

  if (!ALWAYS_SAFE_COMMANDS.has(command)) {
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

  return true;
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
