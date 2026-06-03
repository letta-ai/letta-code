const SEP = "\u0000";
type ShellLaunchOptions = {
  login?: boolean;
  env?: NodeJS.ProcessEnv;
  powershellEnvAliases?: string[];
};

export const STRICT_SHELL_ENV_VAR = "LETTA_BASH_STRICT";
export const STRICT_SHELL_PRELUDE = "set -euo pipefail";
export const POWERSHELL_UTF8_OUTPUT_PREFIX =
  "try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n";

const POWERSHELL_ENV_ALIASES = [
  "MEMORY_DIR",
  "LETTA_MEMORY_DIR",
  "AGENT_ID",
  "LETTA_AGENT_ID",
  "LETTA_PARENT_AGENT_ID",
  "CONVERSATION_ID",
  "LETTA_CONVERSATION_ID",
  "USER_CWD",
];

const WINDOWS_PWSH_FALLBACK_PATH = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
const WINDOWS_POWERSHELL_FALLBACK_PATH =
  "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

function isValidEnvAlias(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

function isTruthyEnvValue(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

export function withStrictShellPrelude(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (process.platform === "win32") return command;
  if (!isTruthyEnvValue(env[STRICT_SHELL_ENV_VAR])) return command;
  return `${STRICT_SHELL_PRELUDE}\n${command}`;
}

function pushUnique(
  list: string[][],
  seen: Set<string>,
  entry: string[],
): void {
  if (!entry.length || !entry[0]) return;
  const key = entry.join(SEP);
  if (seen.has(key)) return;
  seen.add(key);
  list.push(entry);
}

function normalizePowerShellCommand(command: string): string {
  const trimmed = command.trim();
  if (
    trimmed.startsWith("&") ||
    trimmed.startsWith('"') ||
    trimmed.startsWith("'")
  ) {
    return trimmed.startsWith("&") ? trimmed : `& ${trimmed}`;
  }
  return trimmed;
}

function prefixPowerShellCommandWithUtf8Output(command: string): string {
  const trimmed = command.trimStart();
  if (trimmed.startsWith(POWERSHELL_UTF8_OUTPUT_PREFIX)) {
    return command;
  }
  return `${POWERSHELL_UTF8_OUTPUT_PREFIX}${command}`;
}

function stripPowerShellUtf8OutputPrefix(command: string): string {
  const trimmed = command.trimStart();
  if (!trimmed.startsWith(POWERSHELL_UTF8_OUTPUT_PREFIX)) {
    return command;
  }

  const leadingWhitespace = command.slice(0, command.length - trimmed.length);
  return `${leadingWhitespace}${trimmed.slice(POWERSHELL_UTF8_OUTPUT_PREFIX.length)}`;
}

export function buildPowerShellCommand(
  command: string,
  envAliases: string[] = [],
): string {
  const powerShellCommand = stripPowerShellUtf8OutputPrefix(
    normalizePowerShellCommand(command),
  );
  const aliases = [
    ...new Set([...POWERSHELL_ENV_ALIASES, ...envAliases]),
  ].filter(isValidEnvAlias);
  const aliasPrelude = aliases
    .map((name) => `$${name} = $env:${name}`)
    .join("; ");
  return prefixPowerShellCommandWithUtf8Output(
    `${aliasPrelude}; ${powerShellCommand}`,
  );
}

function windowsLaunchers(
  command: string,
  envAliases: string[] = [],
): string[][] {
  const trimmed = command.trim();
  if (!trimmed) return [];
  const launchers: string[][] = [];
  const seen = new Set<string>();
  const powerShellCommand = buildPowerShellCommand(trimmed, envAliases);

  // Match Codex's PowerShell order: prefer PowerShell Core (`pwsh`) when
  // available, then fall back to Windows PowerShell.
  pushUnique(launchers, seen, [
    "pwsh",
    "-NoProfile",
    "-Command",
    powerShellCommand,
  ]);
  pushUnique(launchers, seen, [
    WINDOWS_PWSH_FALLBACK_PATH,
    "-NoProfile",
    "-Command",
    powerShellCommand,
  ]);
  pushUnique(launchers, seen, [
    "powershell",
    "-NoProfile",
    "-Command",
    powerShellCommand,
  ]);
  pushUnique(launchers, seen, [
    WINDOWS_POWERSHELL_FALLBACK_PATH,
    "-NoProfile",
    "-Command",
    powerShellCommand,
  ]);

  // Fall back to cmd.exe if PowerShell fails
  const envComSpecRaw = process.env.ComSpec || process.env.COMSPEC;
  const envComSpec = envComSpecRaw?.trim();
  if (envComSpec) {
    pushUnique(launchers, seen, [envComSpec, "/d", "/s", "/c", trimmed]);
  }
  pushUnique(launchers, seen, ["cmd.exe", "/d", "/s", "/c", trimmed]);

  return launchers;
}

function shellCommandFlag(shellName: string, login: boolean): string {
  if (!login) return "-c";
  const normalized = shellName.replace(/\\/g, "/").toLowerCase();
  if (normalized.includes("bash") || normalized.includes("zsh")) {
    return "-lc";
  }
  return "-c";
}

function unixLaunchers(command: string, login: boolean): string[][] {
  const trimmed = command.trim();
  if (!trimmed) return [];
  const launchers: string[][] = [];
  const seen = new Set<string>();

  // On macOS, ALWAYS prefer zsh first due to bash 3.2's HEREDOC parsing bug
  // with odd numbers of apostrophes. This takes precedence over $SHELL.
  if (process.platform === "darwin") {
    pushUnique(launchers, seen, [
      "/bin/zsh",
      shellCommandFlag("/bin/zsh", login),
      trimmed,
    ]);
  }

  // Try user's preferred shell from $SHELL environment variable
  // Use login semantics only when explicitly requested.
  const envShell = process.env.SHELL?.trim();
  if (envShell) {
    pushUnique(launchers, seen, [
      envShell,
      shellCommandFlag(envShell, login),
      trimmed,
    ]);
  }

  // Fallback defaults - prefer simple "bash" PATH lookup first (like original code),
  // then absolute paths.
  const defaults: string[][] =
    process.platform === "darwin"
      ? [
          ["/bin/zsh", shellCommandFlag("/bin/zsh", login), trimmed],
          ["bash", shellCommandFlag("bash", login), trimmed], // PATH lookup, like original
          ["/bin/bash", shellCommandFlag("/bin/bash", login), trimmed],
          ["/usr/bin/bash", shellCommandFlag("/usr/bin/bash", login), trimmed],
          ["/bin/sh", shellCommandFlag("/bin/sh", login), trimmed],
          ["/bin/ash", shellCommandFlag("/bin/ash", login), trimmed],
          ["/usr/bin/env", "zsh", shellCommandFlag("zsh", login), trimmed],
          ["/usr/bin/env", "bash", shellCommandFlag("bash", login), trimmed],
          ["/usr/bin/env", "sh", shellCommandFlag("sh", login), trimmed],
          ["/usr/bin/env", "ash", shellCommandFlag("ash", login), trimmed],
        ]
      : [
          ["/bin/bash", shellCommandFlag("/bin/bash", login), trimmed],
          ["/usr/bin/bash", shellCommandFlag("/usr/bin/bash", login), trimmed],
          ["/bin/zsh", shellCommandFlag("/bin/zsh", login), trimmed],
          ["/bin/sh", shellCommandFlag("/bin/sh", login), trimmed],
          ["/bin/ash", shellCommandFlag("/bin/ash", login), trimmed],
          ["/usr/bin/env", "bash", shellCommandFlag("bash", login), trimmed],
          ["/usr/bin/env", "zsh", shellCommandFlag("zsh", login), trimmed],
          ["/usr/bin/env", "sh", shellCommandFlag("sh", login), trimmed],
          ["/usr/bin/env", "ash", shellCommandFlag("ash", login), trimmed],
        ];
  for (const entry of defaults) {
    pushUnique(launchers, seen, entry);
  }
  return launchers;
}

export function buildShellLaunchers(
  command: string,
  options?: ShellLaunchOptions,
): string[][] {
  const login = options?.login ?? false;
  const commandToRun = withStrictShellPrelude(command, options?.env);
  return process.platform === "win32"
    ? windowsLaunchers(commandToRun, options?.powershellEnvAliases)
    : unixLaunchers(commandToRun, login);
}
