import type { ModPermissionDefinition } from "@/mods/permission-registry";
import { unregisterModPermission } from "@/mods/permission-registry";
import type { ModToolDefinition } from "@/mods/tool-registry";
import { unregisterModTool } from "@/mods/tool-registry";

export function shouldUnregisterLocalProcessGlobalCapability(
  registerCapabilitiesGlobally: boolean,
  installedProcessGlobal?: boolean,
): boolean {
  return registerCapabilitiesGlobally && installedProcessGlobal === true;
}

export function unregisterProcessGlobalToolsFromLocalRegistry(
  tools: Record<string, ModToolDefinition>,
  ownerId?: string,
): void {
  for (const [name, tool] of Object.entries(tools)) {
    if (!tool.installedProcessGlobal || !tool.owner) {
      continue;
    }
    if (ownerId !== undefined && tool.owner.id !== ownerId) {
      continue;
    }
    unregisterModTool(name, tool.owner);
  }
}

export function unregisterProcessGlobalPermissionsFromLocalRegistry(
  permissions: Record<string, ModPermissionDefinition>,
  ownerId?: string,
): void {
  for (const [id, permission] of Object.entries(permissions)) {
    if (!permission.installedProcessGlobal || !permission.owner) {
      continue;
    }
    if (ownerId !== undefined && permission.owner.id !== ownerId) {
      continue;
    }
    unregisterModPermission(id, permission.owner);
  }
}

export function unregisterProcessGlobalCapabilitiesFromLocalRegistry(
  tools: Record<string, ModToolDefinition>,
  permissions: Record<string, ModPermissionDefinition>,
  ownerId?: string,
): void {
  unregisterProcessGlobalToolsFromLocalRegistry(tools, ownerId);
  unregisterProcessGlobalPermissionsFromLocalRegistry(permissions, ownerId);
}
