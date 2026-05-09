import { homedir } from "node:os";
import { join } from "node:path";

export const LOCAL_BACKEND_DIR_ENV = "LETTA_LOCAL_BACKEND_DIR";
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

export function getLocalBackendStorageDir(homeDir = homedir()): string {
  return (
    process.env[LOCAL_BACKEND_DIR_ENV] ??
    join(homeDir, ".letta", "lc-local-backend")
  );
}

export function getLocalBackendMemoryFilesystemRoot(
  agentId: string,
  storageDir = getLocalBackendStorageDir(),
): string {
  return join(storageDir, "memfs", agentId, "memory");
}
