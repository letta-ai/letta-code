import { join } from "node:path";
import { getLocalBackendStorageDir } from "@/utils/local-backend-paths";

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

let localBackendMemfsDisabledForProcess = false;

export function disableLocalBackendMemfsForProcess(): void {
  localBackendMemfsDisabledForProcess = true;
}

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
