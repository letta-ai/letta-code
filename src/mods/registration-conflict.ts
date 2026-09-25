// Collision handling for mod capability registration.
//
// The shadowing rules exist for two DIFFERENT mods fighting over one command,
// tool, or permission id. A duplicate load of the same file (for example the
// listener and session adapters in one process both loading the global mods
// directory, or the same file arriving through two sources) is not a
// conflict: the registrant is identical. Those are skipped instead of
// throwing, so a duplicate load cannot abort the mod mid-activation and leave
// half its capabilities registered.

import type { ModOwner } from "@/mods/types";

function getModSourcePriority(scope: ModOwner["scope"]): number {
  switch (scope) {
    case "legacy_global":
      return 0;
    case "bundled":
      return 1;
    case "global":
      return 2;
    case "agent":
      return 3;
    case "project":
      return 4;
  }
}

function canShadowOwner(owner: ModOwner, existingOwner?: ModOwner): boolean {
  return (
    existingOwner !== undefined &&
    getModSourcePriority(owner.scope) >
      getModSourcePriority(existingOwner.scope)
  );
}

function isShadowedByOwner(owner: ModOwner, existingOwner?: ModOwner): boolean {
  return (
    existingOwner !== undefined &&
    getModSourcePriority(owner.scope) <
      getModSourcePriority(existingOwner.scope)
  );
}

// owner.id is `${scope}:${path}`: re-registration by the same file at the
// same scope is a duplicate load, not a cross-mod conflict.
function isSameOwnerRegistration(
  owner: ModOwner,
  existingOwner?: ModOwner,
): boolean {
  return existingOwner !== undefined && existingOwner.id === owner.id;
}

export type RegistrationConflictResolution =
  | "skip" // same owner already holds the local registration
  | "skip-global" // only the process-global entry is a same-owner duplicate
  | "proceed";

/**
 * Decide how a capability registration should treat existing registrations.
 * Throws on genuine cross-mod conflicts (same id, different owner); returns
 * how to handle same-owner duplicates otherwise.
 */
export function resolveRegistrationConflict(options: {
  kind: "command" | "tool" | "permission";
  id: string;
  owner: ModOwner;
  override?: boolean;
  existing?: { owner?: ModOwner; path: string };
  existingGlobal?: { owner?: ModOwner; path?: string };
}): RegistrationConflictResolution {
  const { owner, override, existing, existingGlobal } = options;

  if (existing && isSameOwnerRegistration(owner, existing.owner)) {
    return "skip";
  }

  const globalIsDuplicate =
    existingGlobal !== undefined &&
    isSameOwnerRegistration(owner, existingGlobal.owner);
  const conflictOwner =
    existing?.owner ?? (globalIsDuplicate ? undefined : existingGlobal?.owner);
  const conflictPath =
    existing?.path ?? (globalIsDuplicate ? undefined : existingGlobal?.path);

  if (conflictOwner) {
    const label = `Mod ${options.kind} '${options.id}' is already registered by`;
    if (isShadowedByOwner(owner, conflictOwner)) {
      throw new Error(`${label} higher-priority mod ${conflictPath}`);
    }
    if (!override && !canShadowOwner(owner, conflictOwner)) {
      throw new Error(`${label} ${conflictPath}`);
    }
  }

  return globalIsDuplicate ? "skip-global" : "proceed";
}
