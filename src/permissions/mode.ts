// Permission mode management (unrestricted, standard, acceptEdits)

export type PermissionMode = "standard" | "acceptEdits" | "unrestricted";

/** The default starting permission mode. */
export const DEFAULT_PERMISSION_MODE: PermissionMode = "unrestricted";

/** All valid current permission mode values. */
export const VALID_PERMISSION_MODES: readonly PermissionMode[] = [
  "unrestricted",
  "standard",
  "acceptEdits",
] as const;

/**
 * Migrate legacy permission mode strings to their current equivalents.
 * - "default" → "standard" (renamed for clarity)
 * - "bypassPermissions" → "unrestricted" (renamed for clarity)
 * Returns null if the value is not a recognized mode (current or legacy).
 */
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

/**
 * Result of a permission-mode check: the mode auto-allows the tool. A `null`
 * result (not this type) means the mode doesn't apply and normal permission
 * flow continues. The caller surfaces a generic `"Permission mode: {mode}"`
 * message.
 */
export interface ModeOverrideResult {
  decision: "allow";
}

// Use globalThis to ensure singleton across bundle
// This prevents Bun's bundler from creating duplicate instances of the mode manager
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

/**
 * Permission mode state for the current session.
 * Set via CLI --permission-mode flag or settings.json defaultMode.
 */
class PermissionModeManager {
  private get currentMode(): PermissionMode {
    return getGlobalMode();
  }

  private set currentMode(value: PermissionMode) {
    setGlobalMode(value);
  }

  /**
   * Set the permission mode for this session
   */
  setMode(mode: PermissionMode): void {
    this.currentMode = mode;
  }

  /**
   * Get the current permission mode
   */
  getMode(): PermissionMode {
    return this.currentMode;
  }

  /**
   * Check if a tool should be auto-allowed based on current mode.
   * Accepts an explicit `mode` override so callers with a
   * scoped PermissionModeState (listener/remote mode) can bypass the global
   * singleton without requiring a temporary mutation of global state.
   * Returns null if mode doesn't apply to this tool.
   */
  checkModeOverride(
    toolName: string,
    modeOverride?: PermissionMode,
  ): ModeOverrideResult | null {
    const effectiveMode = modeOverride ?? this.currentMode;

    switch (effectiveMode) {
      case "unrestricted":
        // Auto-allow everything else (except explicit deny rules checked earlier)
        return { decision: "allow" };

      case "acceptEdits":
        // Auto-allow edit/write tools across Anthropic, Codex, and Gemini
        // toolsets. These names intentionally cover both snake_case and
        // PascalCase tool registrations used by different providers.
        if (
          [
            "Write",
            "Edit",
            "MultiEdit",
            "NotebookEdit",
            "memory",
            "apply_patch",
            "ApplyPatch",
            "memory_apply_patch",
            "replace",
            "Replace",
            "write_file",
            "WriteFile",
            "write_file_gemini",
            "WriteFileGemini",
          ].includes(toolName)
        ) {
          return { decision: "allow" };
        }
        return null;

      case "standard":
        // No mode overrides, use normal permission flow
        return null;
    }
  }

  /**
   * Reset to default mode
   */
  reset(): void {
    this.currentMode = DEFAULT_PERMISSION_MODE;
  }
}

// Singleton instance
export const permissionMode = new PermissionModeManager();
