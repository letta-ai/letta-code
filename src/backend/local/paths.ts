import { join } from "node:path";
import { getLocalBackendStorageDir } from "@/utils/local-backend-paths";

// The pure path primitives now live in `utils/` so the permissions-layer
// cross-agent guard (below `backend/`, can't import it) can share one
// definition. Re-exported here so existing `@/backend/local/paths` importers
// keep working.
export {
  getLocalBackendCrossAgentTreeRoot,
  getLocalBackendStorageDir,
  LOCAL_BACKEND_DIR_ENV,
} from "@/utils/local-backend-paths";

export const LOCAL_BACKEND_EXPERIMENTAL_ENV =
  "LETTA_LOCAL_BACKEND_EXPERIMENTAL";
export const LOCAL_BACKEND_NO_MEMFS_ENV = "LETTA_LOCAL_BACKEND_NO_MEMFS";

function isTruthyEnv(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

export function isLocalBackendEnvEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isTruthyEnv(env[LOCAL_BACKEND_EXPERIMENTAL_ENV]);
}

export function isLocalBackendNoMemfsEnvEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isTruthyEnv(env[LOCAL_BACKEND_NO_MEMFS_ENV]);
}

export function getLocalBackendMemoryFilesystemRoot(
  agentId: string,
  storageDir = getLocalBackendStorageDir(),
): string {
  return join(storageDir, "memfs", agentId, "memory");
}
