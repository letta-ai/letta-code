import { homedir } from "node:os";
import { isAbsolute, join, normalize, resolve } from "node:path";

/**
 * Resolve the process-wide config directory. Product hosts may isolate their
 * settings, credentials, and device identity without replacing HOME for every
 * child process.
 */
export function resolveGlobalConfigDir(
  env: NodeJS.ProcessEnv = process.env,
  fallbackHome: string = homedir(),
): string {
  const override = env.LETTA_CONFIG_DIR?.trim();
  if (override) {
    if (!isAbsolute(override)) {
      throw new Error("LETTA_CONFIG_DIR must be absolute");
    }
    return normalize(override);
  }
  return join(env.HOME || fallbackHome, ".letta");
}

export function resolveGlobalSettingsPath(
  env: NodeJS.ProcessEnv = process.env,
  fallbackHome: string = homedir(),
): string {
  return join(resolveGlobalConfigDir(env, fallbackHome), "settings.json");
}

export function hasGlobalConfigDirOverride(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return Boolean(env.LETTA_CONFIG_DIR?.trim());
}

export function isHomeWorkingDirectory(
  workingDirectory: string,
  env: NodeJS.ProcessEnv = process.env,
  fallbackHome: string = homedir(),
): boolean {
  return resolve(workingDirectory) === resolve(env.HOME || fallbackHome);
}

export function isProjectSettingsPathGlobal(
  workingDirectory: string,
  env: NodeJS.ProcessEnv = process.env,
  fallbackHome: string = homedir(),
): boolean {
  return (
    isHomeWorkingDirectory(workingDirectory, env, fallbackHome) ||
    resolve(workingDirectory, ".letta", "settings.json") ===
      resolveGlobalSettingsPath(env, fallbackHome)
  );
}
