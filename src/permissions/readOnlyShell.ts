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

const DANGEROUS_OPERATOR_PATTERN = /(>>|>|&&|\|\||;|\$\(|`)/;

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

  const segments = trimmed
    .split("|")
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
