export const LETTA_DISABLE_MODS_ENV = "LETTA_DISABLE_MODS";
export const LEGACY_LETTA_DISABLE_EXTENSIONS_ENV = "LETTA_DISABLE_EXTENSIONS";

function isTruthyEnvFlag(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(normalized);
}

export function areModsDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    isTruthyEnvFlag(env[LETTA_DISABLE_MODS_ENV]) ||
    isTruthyEnvFlag(env[LEGACY_LETTA_DISABLE_EXTENSIONS_ENV])
  );
}

export function shouldDisableMods(options?: {
  cliFlag?: boolean;
  env?: NodeJS.ProcessEnv;
}): boolean {
  return Boolean(
    options?.cliFlag || areModsDisabled(options?.env ?? process.env),
  );
}

export function disableModsForProcess(): void {
  process.env[LETTA_DISABLE_MODS_ENV] = "1";
}
