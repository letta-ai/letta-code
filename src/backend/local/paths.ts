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

/**
 * The tree holding every local-backend agent's memory (`<storage>/memfs`) — the
 * cross-agent boundary the filesystem sandbox walls off, analogous to
 * `~/.letta/agents` on the API backend. Each agent's memory lives at
 * `<this>/<agentId>/memory`, so the sandbox carves self the same way on both
 * backends. Resolved here (in `backend/`) because the policy builders live in
 * `permissions/`, below `backend/`, and cannot import this layer.
 */
export function getLocalBackendCrossAgentTreeRoot(
  storageDir = getLocalBackendStorageDir(),
): string {
  return join(storageDir, "memfs");
}

/**
 * The local-backend persistence dirs OUTSIDE the memfs tree that the in-process
 * backend writes as harness metadata: conversation state, agent-state files, and
 * provider auth. Under the write-scoped (restrictWrites:true) memory-mode
 * sandbox these must be carved writable so the subagent child can persist
 * normally — the API backend does this server-side, so it needs no equivalent.
 */
export function getLocalBackendHarnessWritableRoots(
  storageDir = getLocalBackendStorageDir(),
): string[] {
  return [
    join(storageDir, "conversations"),
    join(storageDir, "agents"),
    join(storageDir, "providers"),
  ];
}
