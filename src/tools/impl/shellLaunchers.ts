const SEP = "\u0000";
type ShellLaunchOptions = {
  login?: boolean;
};

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

function windowsLaunchers(command: string): string[][] {
  const trimmed = command.trim();
  if (!trimmed) return [];
  const launchers: string[][] = [];
  const seen = new Set<string>();
  const powerShellCommand =
    trimmed.startsWith("&") ||
    trimmed.startsWith('"') ||
    trimmed.startsWith("'")
      ? trimmed.startsWith("&")
        ? trimmed
        : `& ${trimmed}`
      : trimmed;

  // Default to PowerShell on Windows (same as Gemini CLI and Codex CLI)
  // This ensures better PATH compatibility since many tools are configured
  // in PowerShell profiles rather than system-wide cmd.exe PATH
  pushUnique(launchers, seen, [
    "powershell.exe",
    "-NoProfile",
    "-Command",
    powerShellCommand,
  ]);
  pushUnique(launchers, seen, [
    "pwsh",
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
  return process.platform === "win32"
    ? windowsLaunchers(command)
    : unixLaunchers(command, login);
}
