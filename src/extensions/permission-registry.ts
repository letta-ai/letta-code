import type {
  ExtensionContext,
  ExtensionOwner,
  ExtensionPermission,
  ExtensionPermissionCheckEvent,
  ExtensionPermissionCheckResult,
} from "@/extensions/types";
import { areExtensionsDisabled } from "./disable";

const EXTENSION_PERMISSIONS_KEY = Symbol.for("@letta/extensionPermissions");

type GlobalWithExtensionPermissions = typeof globalThis & {
  [EXTENSION_PERMISSIONS_KEY]?: Map<string, ExtensionPermissionDefinition>;
};

export interface ExtensionPermissionDefinition extends ExtensionPermission {
  activationSignal: AbortSignal;
  getContext: () => ExtensionContext;
  isAvailable: () => boolean;
}

export interface ExtensionPermissionDecisionResult {
  decision: "allow" | "ask" | "deny";
  matchedRule: string;
  reason?: string;
}

function getMutableExtensionPermissionsRegistry(): Map<
  string,
  ExtensionPermissionDefinition
> {
  const global = globalThis as GlobalWithExtensionPermissions;
  if (!global[EXTENSION_PERMISSIONS_KEY]) {
    global[EXTENSION_PERMISSIONS_KEY] = new Map();
  }
  return global[EXTENSION_PERMISSIONS_KEY];
}

export function getAvailableExtensionPermissionsRegistry(): Map<
  string,
  ExtensionPermissionDefinition
> {
  if (areExtensionsDisabled()) return new Map();

  return new Map(
    Array.from(getMutableExtensionPermissionsRegistry().entries()).filter(
      ([, permission]) => {
        if (permission.activationSignal.aborted) return false;
        try {
          return permission.isAvailable();
        } catch {
          return false;
        }
      },
    ),
  );
}

export function registerExtensionPermission(
  permission: ExtensionPermissionDefinition,
): void {
  if (areExtensionsDisabled()) return;
  getMutableExtensionPermissionsRegistry().set(permission.id, permission);
}

export function unregisterExtensionPermission(
  id: string,
  owner: ExtensionOwner,
): void {
  const registry = getMutableExtensionPermissionsRegistry();
  const existing = registry.get(id);
  if (existing?.owner?.id === owner.id) {
    registry.delete(id);
  }
}

export function unregisterExtensionPermissionsForOwner(
  owner: ExtensionOwner,
): void {
  const registry = getMutableExtensionPermissionsRegistry();
  for (const [id, permission] of registry.entries()) {
    if (permission.owner?.id === owner.id) {
      registry.delete(id);
    }
  }
}

export function clearExtensionPermissions(): void {
  getMutableExtensionPermissionsRegistry().clear();
}

export function getExtensionPermissionDefinition(
  id: string,
  registry: Map<
    string,
    ExtensionPermissionDefinition
  > = getMutableExtensionPermissionsRegistry(),
): ExtensionPermissionDefinition | undefined {
  if (areExtensionsDisabled()) return undefined;
  return registry.get(id);
}

function normalizePermissionResult(
  result: ExtensionPermissionCheckResult,
): ExtensionPermissionCheckResult {
  if (result === undefined) return undefined;
  if (
    result.decision === "allow" ||
    result.decision === "ask" ||
    result.decision === "deny"
  ) {
    return result;
  }
  return undefined;
}

function composePermissionDecision(
  decisions: ExtensionPermissionDecisionResult[],
): ExtensionPermissionDecisionResult | undefined {
  return (
    decisions.find((result) => result.decision === "deny") ??
    decisions.find((result) => result.decision === "ask") ??
    decisions.find((result) => result.decision === "allow")
  );
}

export async function checkExtensionPermissions(
  event: ExtensionPermissionCheckEvent,
  registry: Map<
    string,
    ExtensionPermissionDefinition
  > = getAvailableExtensionPermissionsRegistry(),
): Promise<ExtensionPermissionDecisionResult | undefined> {
  if (areExtensionsDisabled()) return undefined;

  const decisions: ExtensionPermissionDecisionResult[] = [];
  for (const permission of registry.values()) {
    if (permission.activationSignal.aborted) continue;

    let rawResult: ExtensionPermissionCheckResult;
    try {
      if (!permission.isAvailable()) continue;
      rawResult = await permission.check(event, {
        getContext: permission.getContext,
        signal: permission.activationSignal,
      });
    } catch (error) {
      return {
        decision: "deny",
        matchedRule: `extension permission:${permission.id}`,
        reason: `Extension permission '${permission.id}' failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    const result = normalizePermissionResult(rawResult);
    if (!result) continue;
    decisions.push({
      decision: result.decision,
      matchedRule: `extension permission:${permission.id}`,
      reason: result.reason,
    });
  }

  return composePermissionDecision(decisions);
}
