const SHELL_EXECUTORS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);

function trimMatchingQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) {
    return trimmed;
  }

  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === '"' || first === "'") && last === first) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function normalizeExecutableToken(token: string): string {
  const normalized = trimMatchingQuotes(token).replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  const executable = parts[parts.length - 1] ?? normalized;
  return executable.toLowerCase();
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

function isDashCFlag(token: string): boolean {
  return token === "-c" || /^-[a-zA-Z]*c[a-zA-Z]*$/.test(token);
}

function extractInnerShellCommand(tokens: string[]): string | null {
  if (tokens.length === 0) {
    return null;
  }

  let index = 0;

  if (normalizeExecutableToken(tokens[0] ?? "") === "env") {
    index += 1;
    while (index < tokens.length) {
      const token = tokens[index] ?? "";
      if (!token) {
        index += 1;
        continue;
      }

      if (/^-[A-Za-z]+$/.test(token)) {
        index += 1;
        continue;
      }

      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
        index += 1;
        continue;
      }

      break;
    }
  }

  const executableToken = tokens[index];
  if (!executableToken) {
    return null;
  }
  if (!SHELL_EXECUTORS.has(normalizeExecutableToken(executableToken))) {
    return null;
  }

  for (let i = index + 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token) {
      continue;
    }
    if (!isDashCFlag(token)) {
      continue;
    }

    const innerCommand = tokens[i + 1];
    if (!innerCommand) {
      return null;
    }

    return trimMatchingQuotes(innerCommand);
  }

  return null;
}

export function unwrapShellLauncherCommand(command: string): string {
  let current = command.trim();
  for (let depth = 0; depth < 5; depth += 1) {
    if (!current) {
      break;
    }
    const tokens = tokenizeShell(current);
    const inner = extractInnerShellCommand(tokens);
    if (!inner || inner === current) {
      break;
    }
    current = inner.trim();
  }
  return current;
}

export function normalizeBashRulePayload(payload: string): string {
  const trimmed = payload.trim();
  if (!trimmed) {
    return "";
  }

  const hasWildcardSuffix = trimmed.endsWith(":*");
  const withoutWildcard = hasWildcardSuffix
    ? trimmed.slice(0, -2).trimEnd()
    : trimmed;
  const unwrapped = unwrapShellLauncherCommand(withoutWildcard);

  if (hasWildcardSuffix) {
    return `${unwrapped}:*`;
  }
  return unwrapped;
}
