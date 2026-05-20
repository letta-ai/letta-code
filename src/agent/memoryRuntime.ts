import { getBackend } from "@/backend";
import { settingsManager } from "@/settings-manager";
import { getScopedMemoryFilesystemRoot } from "./memoryFilesystem";

/**
 * Runtime MemFS state for the active backend.
 *
 * Cloud/API MemFS is an agent setting. Local backend MemFS is a backend
 * capability unless explicitly disabled before backend construction, so most
 * UI surfaces should treat local backend agents as MemFS-enabled even before a
 * persisted per-agent setting exists.
 */
export function isActiveMemfsEnabled(agentId: string): boolean {
  return (
    getBackend().capabilities.localMemfs ||
    settingsManager.isMemfsEnabled(agentId)
  );
}

export function getActiveMemoryDirectory(agentId: string): string | undefined {
  return isActiveMemfsEnabled(agentId)
    ? getScopedMemoryFilesystemRoot(agentId)
    : undefined;
}

export function isLocalMemfsActive(): boolean {
  return getBackend().capabilities.localMemfs;
}
