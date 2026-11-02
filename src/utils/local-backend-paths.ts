import { join } from "node:path";
import {
  hasGlobalConfigDirOverride,
  resolveGlobalConfigDir,
} from "@/utils/settings-path";

/**
 * Env override for the local-backend storage dir (defaults to
 * `<product-config>/lc-local-backend`).
 */
export const LOCAL_BACKEND_DIR_ENV = "LETTA_LOCAL_BACKEND_DIR";

/**
 * Root dir holding all local-backend on-disk state. Pure path resolution (home
 * dir + one env override).
 *
 * Lives in `utils/` (the bottom layer) so it can be shared by both `backend/`
 * — which owns the local store — and the `permissions/` cross-agent guard, which
 * sits below `backend/` and cannot import it but still needs to know where
 * local memory lives to wall off cross-agent access for in-process file tools.
 */
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

/**
 * The tree holding every local-backend agent's memory (`<storage>/memfs`) — the
 * cross-agent boundary the filesystem sandbox walls off, analogous to
 * `~/.letta/agents` on the API backend. Each agent's memory lives at
 * `<this>/<agentId>/memory`, so self is carved the same way on both backends.
 */
export function getLocalBackendCrossAgentTreeRoot(
  storageDir: string = getLocalBackendStorageDir(),
): string {
  return join(storageDir, "memfs");
}
