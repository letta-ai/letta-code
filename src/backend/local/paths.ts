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

function isTruthyEnv(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

export function isLocalBackendEnvEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isTruthyEnv(env[LOCAL_BACKEND_EXPERIMENTAL_ENV]);
}

// Internal process-level memfs kill switch for the local backend.
//
// Only used for stateless subagent processes (LETTA_CODE_AGENT_ROLE=subagent
// spawning a fresh agent): they skip local memfs setup entirely. This is NOT
// user-configurable — there is no CLI flag or environment variable. All
// user-facing agents are memfs-enabled unconditionally.
let localBackendMemfsDisabledForProcess = false;

export function disableLocalBackendMemfsForProcess(): void {
  localBackendMemfsDisabledForProcess = true;
}

/** Test-only: restore the default (memfs enabled) after a test disabled it. */
export function resetLocalBackendMemfsForProcess(): void {
  localBackendMemfsDisabledForProcess = false;
}

export function isLocalBackendMemfsDisabledForProcess(): boolean {
  return localBackendMemfsDisabledForProcess;
}

export function getLocalBackendMemoryFilesystemRoot(
  agentId: string,
  storageDir = getLocalBackendStorageDir(),
): string {
  return join(storageDir, "memfs", agentId, "memory");
}
