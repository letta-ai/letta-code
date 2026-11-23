import { join } from "node:path";
import {
  hasGlobalConfigDirOverride,
  resolveGlobalConfigDir,
} from "@/utils/settings-path";

export const LOCAL_BACKEND_DIR_ENV = "LETTA_LOCAL_BACKEND_DIR";

export function getLocalBackendStorageDir(
  homeDir?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configDir =
    homeDir === undefined || hasGlobalConfigDirOverride(env)
      ? resolveGlobalConfigDir(env, homeDir)
      : join(homeDir, ".letta");
  return env[LOCAL_BACKEND_DIR_ENV] ?? join(configDir, "lc-local-backend");
}

export function getLocalBackendCrossAgentTreeRoot(
  storageDir: string = getLocalBackendStorageDir(),
): string {
  return join(storageDir, "memfs");
}
