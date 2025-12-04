const SEP = "\u0000";

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
  const envComSpecRaw = process.env.ComSpec || process.env.COMSPEC;
  const envComSpec = envComSpecRaw?.trim();
  if (envComSpec) {
    pushUnique(launchers, seen, [envComSpec, "/d", "/s", "/c", trimmed]);
  }
  pushUnique(launchers, seen, ["cmd.exe", "/d", "/s", "/c", trimmed]);
  pushUnique(launchers, seen, [
    "powershell.exe",
    "-NoProfile",
    "-Command",
    trimmed,
  ]);
  pushUnique(launchers, seen, ["pwsh", "-NoProfile", "-Command", trimmed]);
  return launchers;
}

function unixLaunchers(command: string): string[][] {
  const trimmed = command.trim();
  if (!trimmed) return [];
  const launchers: string[][] = [];
  const seen = new Set<string>();
  const envShell = process.env.SHELL?.trim();
  if (envShell) {
    pushUnique(launchers, seen, [envShell, "-lc", trimmed]);
    pushUnique(launchers, seen, [envShell, "-c", trimmed]);
  }
  const defaults: string[][] = [
    ["/bin/bash", "-lc", trimmed],
    ["/usr/bin/bash", "-lc", trimmed],
    ["/bin/zsh", "-lc", trimmed],
    ["/bin/sh", "-c", trimmed],
    ["/bin/ash", "-c", trimmed],
    ["/usr/bin/env", "bash", "-lc", trimmed],
    ["/usr/bin/env", "zsh", "-lc", trimmed],
    ["/usr/bin/env", "sh", "-c", trimmed],
    ["/usr/bin/env", "ash", "-c", trimmed],
  ];
  for (const entry of defaults) {
    pushUnique(launchers, seen, entry);
  }
  return launchers;
}

export function buildShellLaunchers(command: string): string[][] {
  return process.platform === "win32"
    ? windowsLaunchers(command)
    : unixLaunchers(command);
}
