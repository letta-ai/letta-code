import { getBackend } from "@/backend";
import { settingsManager } from "@/settings-manager";
import { isMemoryUnavailable } from "@/utils/memory-access";
import { getScopedMemoryFilesystemRoot } from "./memory-filesystem";

export function isActiveMemfsEnabled(agentId: string): boolean {
  return (
    !isMemoryUnavailable(agentId) &&
    (getBackend().capabilities.localMemfs ||
      settingsManager.isMemfsEnabled(agentId))
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
