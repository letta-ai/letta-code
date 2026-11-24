export type PermissionMode =
  | "standard"
  | "acceptEdits"
  | "unrestricted"
  | "strict";

export const DEFAULT_PERMISSION_MODE: PermissionMode = "unrestricted";

export const VALID_PERMISSION_MODES: readonly PermissionMode[] = [
  "unrestricted",
  "standard",
  "acceptEdits",
  "strict",
] as const;

export function migratePermissionMode(value: string): PermissionMode | null {
  if (VALID_PERMISSION_MODES.includes(value as PermissionMode)) {
    return value as PermissionMode;
  }
  if (value === "default") return "standard";
  if (value === "bypassPermissions" || value === "fullAccess") {
    return "unrestricted";
  }
  return null;
}

export interface ModeOverrideResult {
  decision: "allow";
}

const MODE_KEY = Symbol.for("@letta/permissionMode");

type GlobalWithMode = typeof globalThis & {
  [MODE_KEY]: PermissionMode;
};

function getGlobalMode(): PermissionMode {
  const global = globalThis as GlobalWithMode;
  if (!global[MODE_KEY]) {
    global[MODE_KEY] = DEFAULT_PERMISSION_MODE;
  }
  return global[MODE_KEY];
}

function setGlobalMode(value: PermissionMode): void {
  const global = globalThis as GlobalWithMode;
  global[MODE_KEY] = value;
}

class PermissionModeManager {
  private get currentMode(): PermissionMode {
    return getGlobalMode();
  }

  private set currentMode(value: PermissionMode) {
    setGlobalMode(value);
  }

  setMode(mode: PermissionMode): void {
    this.currentMode = mode;
  }

  getMode(): PermissionMode {
    return this.currentMode;
  }

  checkModeOverride(
    toolName: string,
    modeOverride?: PermissionMode,
  ): ModeOverrideResult | null {
    const effectiveMode = modeOverride ?? this.currentMode;

    switch (effectiveMode) {
      case "unrestricted":
        return { decision: "allow" };

      case "acceptEdits":
        if (
          ["Write", "Edit", "NotebookEdit", "ApplyPatch"].includes(toolName)
        ) {
          return { decision: "allow" };
        }
        return null;

      case "standard":
        return null;

      case "strict":
        return null;
    }
  }

  isStrict(modeOverride?: PermissionMode): boolean {
    return (modeOverride ?? this.currentMode) === "strict";
  }

  reset(): void {
    this.currentMode = DEFAULT_PERMISSION_MODE;
  }
}

export const permissionMode = new PermissionModeManager();
