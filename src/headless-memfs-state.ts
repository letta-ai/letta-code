import { settingsManager } from "@/settings-manager";

export function resolveHeadlessMemfsEnabled(
  agentId: string,
  override?: boolean,
): boolean {
  if (override !== undefined) {
    return override;
  }
  try {
    return settingsManager.isMemfsEnabled(agentId);
  } catch {
    return false;
  }
}

export function createHeadlessMemfsResolver(
  override?: boolean,
): (agentId: string) => boolean {
  return (agentId) => resolveHeadlessMemfsEnabled(agentId, override);
}
