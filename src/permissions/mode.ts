// src/permissions/mode.ts
// Permission mode management (default, acceptEdits, plan, bypassPermissions)

export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "plan"
  | "bypassPermissions";

// Use globalThis to ensure singleton across bundle
// This prevents Bun's bundler from creating duplicate instances of the mode manager
const MODE_KEY = Symbol.for("@letta/permissionMode");
const PLAN_FILE_KEY = Symbol.for("@letta/planFilePath");

type GlobalWithMode = typeof globalThis & {
  [MODE_KEY]: PermissionMode;
  [PLAN_FILE_KEY]: string | null;
};

function getGlobalMode(): PermissionMode {
  const global = globalThis as GlobalWithMode;
  if (!global[MODE_KEY]) {
    global[MODE_KEY] = "default";
  }
  return global[MODE_KEY];
}

function setGlobalMode(value: PermissionMode): void {
  const global = globalThis as GlobalWithMode;
  global[MODE_KEY] = value;
}

function getGlobalPlanFilePath(): string | null {
  const global = globalThis as GlobalWithMode;
  return global[PLAN_FILE_KEY] || null;
}

function setGlobalPlanFilePath(value: string | null): void {
  const global = globalThis as GlobalWithMode;
  global[PLAN_FILE_KEY] = value;
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
    // Clear plan file path when exiting plan mode
    if (mode !== "plan") {
      setGlobalPlanFilePath(null);
    }
  }

  /**
   * Get the current permission mode
   */
  getMode(): PermissionMode {
    return this.currentMode;
  }

  /**
   * Set the plan file path (only relevant when in plan mode)
   */
  setPlanFilePath(path: string | null): void {
    setGlobalPlanFilePath(path);
  }

  /**
   * Get the current plan file path
   */
  getPlanFilePath(): string | null {
    return getGlobalPlanFilePath();
  }

  /**
   * Check if a tool should be auto-allowed based on current mode
   * Returns null if mode doesn't apply to this tool
   */
  checkModeOverride(
    toolName: string,
    toolArgs?: Record<string, unknown>,
  ): "allow" | "deny" | null {
    switch (this.currentMode) {
      case "bypassPermissions":
        // Auto-allow everything (except explicit deny rules checked earlier)
        return "allow";

      case "acceptEdits":
        // Auto-allow edit tools: Write, Edit, MultiEdit, NotebookEdit, apply_patch, replace, write_file
        if (
          [
            "Write",
            "Edit",
            "MultiEdit",
            "NotebookEdit",
            "apply_patch",
            "replace",
            "write_file",
          ].includes(toolName)
        ) {
          return "allow";
        }
        return null;

      case "plan": {
        // Read-only mode: allow analysis tools, deny modification tools
        const allowedInPlan = [
          "Read",
          "Glob",
          "Grep",
          "NotebookRead",
          "TodoWrite",
        ];
        const writeTools = ["Write", "Edit", "MultiEdit", "NotebookEdit"];
        const deniedInPlan = ["Bash", "WebFetch"];

        if (allowedInPlan.includes(toolName)) {
          return "allow";
        }

        // Special case: allow writes to the plan file only
        if (writeTools.includes(toolName)) {
          const planFilePath = this.getPlanFilePath();
          const targetPath =
            (toolArgs?.file_path as string) || (toolArgs?.path as string);

          if (planFilePath && targetPath && targetPath === planFilePath) {
            return "allow";
          }
          return "deny";
        }

        if (deniedInPlan.includes(toolName)) {
          return "deny";
        }
        return null;
      }

      case "default":
        // No mode overrides, use normal permission flow
        return null;

      default:
        return null;
    }
  }

  /**
   * Reset to default mode
   */
  reset(): void {
    this.currentMode = "default";
  }
}

// Singleton instance
export const permissionMode = new PermissionModeManager();
