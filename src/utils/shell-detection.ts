const DASH_C_SHELLS = new Set(["bash", "sh", "zsh", "ash", "dash"]);

export function preferredShellFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const value = env.SHELL;
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;
  const first = trimmed[0];
  const last = trimmed.at(-1);
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function acceptsDashC(shellPath: string): boolean {
  const normalized = shellPath.replace(/\\/g, "/").toLowerCase();
  const basename = normalized.split("/").pop() ?? normalized;
  const name = basename.endsWith(".exe") ? basename.slice(0, -4) : basename;
  return DASH_C_SHELLS.has(name);
}
