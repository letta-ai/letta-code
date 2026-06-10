import type {
  ModContext,
  ModOwner,
  ModPermission,
  ModPermissionCheckEvent,
  ModPermissionCheckResult,
} from "@/mods/types";
import { areModsDisabled } from "./disable";

const MOD_PERMISSIONS_KEY = Symbol.for("@letta/modPermissions");

type GlobalWithModPermissions = typeof globalThis & {
  [MOD_PERMISSIONS_KEY]?: Map<string, ModPermissionDefinition>;
};

export interface ModPermissionDefinition extends ModPermission {
  activationSignal: AbortSignal;
  getContext: () => ModContext;
  isAvailable: () => boolean;
}

export interface ModPermissionDecisionResult {
  decision: "allow" | "ask" | "deny";
  matchedRule: string;
  reason?: string;
}

function getMutableModPermissionsRegistry(): Map<
  string,
  ModPermissionDefinition
> {
  const global = globalThis as GlobalWithModPermissions;
  if (!global[MOD_PERMISSIONS_KEY]) {
    global[MOD_PERMISSIONS_KEY] = new Map();
  }
  return global[MOD_PERMISSIONS_KEY];
}

export function getAvailableModPermissionsRegistry(): Map<
  string,
  ModPermissionDefinition
> {
  if (areModsDisabled()) return new Map();

  return new Map(
    Array.from(getMutableModPermissionsRegistry().entries()).filter(
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

export function registerModPermission(
  permission: ModPermissionDefinition,
): void {
  if (areModsDisabled()) return;
  getMutableModPermissionsRegistry().set(permission.id, permission);
}

export function unregisterModPermission(id: string, owner: ModOwner): void {
  const registry = getMutableModPermissionsRegistry();
  const existing = registry.get(id);
  if (existing?.owner?.id === owner.id) {
    registry.delete(id);
  }
}

export function unregisterModPermissionsForOwner(owner: ModOwner): void {
  const registry = getMutableModPermissionsRegistry();
  for (const [id, permission] of registry.entries()) {
    if (permission.owner?.id === owner.id) {
      registry.delete(id);
    }
  }
}

export function clearModPermissions(): void {
  getMutableModPermissionsRegistry().clear();
}

export function getModPermissionDefinition(
  id: string,
  registry: Map<
    string,
    ModPermissionDefinition
  > = getMutableModPermissionsRegistry(),
): ModPermissionDefinition | undefined {
  if (areModsDisabled()) return undefined;
  return registry.get(id);
}

function normalizePermissionResult(
  result: ModPermissionCheckResult,
): ModPermissionCheckResult {
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
  decisions: ModPermissionDecisionResult[],
): ModPermissionDecisionResult | undefined {
  return (
    decisions.find((result) => result.decision === "deny") ??
    decisions.find((result) => result.decision === "ask") ??
    decisions.find((result) => result.decision === "allow")
  );
}

export async function checkModPermissions(
  event: ModPermissionCheckEvent,
  registry: Map<
    string,
    ModPermissionDefinition
  > = getAvailableModPermissionsRegistry(),
): Promise<ModPermissionDecisionResult | undefined> {
  if (areModsDisabled()) return undefined;

  const decisions: ModPermissionDecisionResult[] = [];
  for (const permission of registry.values()) {
    if (permission.activationSignal.aborted) continue;

    let rawResult: ModPermissionCheckResult;
    try {
      if (!permission.isAvailable()) continue;
      rawResult = await permission.check(event, {
        getContext: permission.getContext,
        signal: permission.activationSignal,
      });
    } catch (error) {
      return {
        decision: "deny",
        matchedRule: `mod permission:${permission.id}`,
        reason: `Mod permission '${permission.id}' failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    const result = normalizePermissionResult(rawResult);
    if (!result) continue;
    decisions.push({
      decision: result.decision,
      matchedRule: `mod permission:${permission.id}`,
      reason: result.reason,
    });
  }

  return composePermissionDecision(decisions);
}
