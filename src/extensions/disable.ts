export const LETTA_DISABLE_EXTENSIONS_ENV = "LETTA_DISABLE_EXTENSIONS";

function isTruthyEnvFlag(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(normalized);
}

export function areExtensionsDisabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isTruthyEnvFlag(env[LETTA_DISABLE_EXTENSIONS_ENV]);
}

export function shouldDisableExtensions(options?: {
  cliFlag?: boolean;
  env?: NodeJS.ProcessEnv;
}): boolean {
  return Boolean(
    options?.cliFlag || areExtensionsDisabled(options?.env ?? process.env),
  );
}

export function disableExtensionsForProcess(): void {
  process.env[LETTA_DISABLE_EXTENSIONS_ENV] = "1";
}
