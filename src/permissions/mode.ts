// src/permissions/mode.ts
// Permission mode management (default, acceptEdits, plan, bypassPermissions)

import { homedir } from "node:os";
import { join } from "node:path";

import { isReadOnlyShellCommand } from "./readOnlyShell";

export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "plan"
  | "bypassPermissions";

// Use globalThis to ensure singleton across bundle
// This prevents Bun's bundler from creating duplicate instances of the mode manager
const MODE_KEY = Symbol.for("@letta/permissionMode");
const PLAN_FILE_KEY = Symbol.for("@letta/planFilePath");
const MODE_BEFORE_PLAN_KEY = Symbol.for("@letta/permissionModeBeforePlan");

type GlobalWithMode = typeof globalThis & {
  [MODE_KEY]: PermissionMode;
  [PLAN_FILE_KEY]: string | null;
  [MODE_BEFORE_PLAN_KEY]?: PermissionMode | null;
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

function getGlobalModeBeforePlan(): PermissionMode | null {
  const global = globalThis as GlobalWithMode;
  return global[MODE_BEFORE_PLAN_KEY] ?? null;
}

function setGlobalModeBeforePlan(value: PermissionMode | null): void {
  const global = globalThis as GlobalWithMode;
  global[MODE_BEFORE_PLAN_KEY] = value;
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
    const prevMode = this.currentMode;

    // If we are entering plan mode, remember what mode we were previously in so
    // ExitPlanMode can restore it (e.g. YOLO).
    if (mode === "plan" && prevMode !== "plan") {
      setGlobalModeBeforePlan(prevMode);
    }

    this.currentMode = mode;

    // Clear plan file path when exiting plan mode
    if (mode !== "plan") {
      setGlobalPlanFilePath(null);
    }

    // Once we leave plan mode, the remembered mode has been consumed.
    if (prevMode === "plan" && mode !== "plan") {
      setGlobalModeBeforePlan(null);
    }
  }

  /**
   * Get the permission mode that was active before entering plan mode.
   * Used to restore the user's previous setting (e.g., bypassPermissions).
   */
  getModeBeforePlan(): PermissionMode | null {
    return getGlobalModeBeforePlan();
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
        // Read-only mode: allow analysis tools, deny everything else
        const allowedInPlan = [
          // Anthropic toolset
          "Read",
          "Glob",
          "Grep",
          "NotebookRead",
          "TodoWrite",
          // Plan mode tools (must allow exit!)
          "ExitPlanMode",
          "exit_plan_mode",
          "AskUserQuestion",
          "ask_user_question",
          // Codex toolset (snake_case)
          "read_file",
          "list_dir",
          "grep_files",
          "update_plan",
          // Codex toolset (PascalCase)
          "ReadFile",
          "ListDir",
          "GrepFiles",
          "UpdatePlan",
          // Gemini toolset (snake_case)
          "list_directory",
          "search_file_content",
          "write_todos",
          "read_many_files",
          // Gemini toolset (PascalCase)
          "ListDirectory",
          "SearchFileContent",
          "WriteTodos",
          "ReadManyFiles",
        ];
        const writeTools = [
          // Anthropic toolset (PascalCase only)
          "Write",
          "Edit",
          "MultiEdit",
          // Codex toolset (snake_case and PascalCase)
          "apply_patch",
          "ApplyPatch",
          // Gemini toolset (snake_case and PascalCase)
          "write_file_gemini",
          "WriteFileGemini",
          "replace",
          "Replace",
        ];

        if (allowedInPlan.includes(toolName)) {
          return "allow";
        }

        // Special case: allow writes to any plan file in ~/.letta/plans/
        // NOTE: We allow writing to ANY plan file, not just the assigned one.
        // This is intentional - it allows the agent to "resume" planning after
        // plan mode was exited/reset by simply writing to any plan file.
        if (writeTools.includes(toolName)) {
          const plansDir = join(homedir(), ".letta", "plans");
          let targetPath =
            (toolArgs?.file_path as string) || (toolArgs?.path as string);

          // ApplyPatch/apply_patch: extract file path from patch input
          if (
            (toolName === "ApplyPatch" || toolName === "apply_patch") &&
            toolArgs?.input
          ) {
            const input = toolArgs.input as string;
            // Extract path from "*** Add File: path", "*** Update File: path", or "*** Delete File: path"
            const match = input.match(
              /\*\*\* (?:Add|Update|Delete) File:\s*(.+)/,
            );
            if (match?.[1]) {
              targetPath = match[1].trim();
            }
          }

          // Allow if target is any .md file in the plans directory
          if (targetPath?.startsWith(plansDir) && targetPath.endsWith(".md")) {
            return "allow";
          }
        }

        // Allow Task tool with read-only subagent types
        // These subagents only have access to read-only tools (Glob, Grep, Read, LS, BashOutput)
        const readOnlySubagentTypes = new Set([
          "explore",
          "Explore",
          "plan",
          "Plan",
          "recall",
          "Recall",
        ]);
        if (toolName === "Task" || toolName === "task") {
          const subagentType = toolArgs?.subagent_type as string | undefined;
          if (subagentType && readOnlySubagentTypes.has(subagentType)) {
            return "allow";
          }
        }

        // Allow Skill tool — skills are read-only (load instructions, not modify files)
        if (toolName === "Skill" || toolName === "skill") {
          return "allow";
        }

        // Allow read-only shell commands (ls, git status, git log, etc.)
        const shellTools = [
          "Bash",
          "shell",
          "Shell",
          "shell_command",
          "ShellCommand",
          "run_shell_command",
          "RunShellCommand",
        ];
        if (shellTools.includes(toolName)) {
          const command = toolArgs?.command as string | string[] | undefined;
          if (command && isReadOnlyShellCommand(command)) {
            return "allow";
          }
        }

        // Everything else denied in plan mode
        return "deny";
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
    setGlobalPlanFilePath(null);
    setGlobalModeBeforePlan(null);
  }
}

// Singleton instance
export const permissionMode = new PermissionModeManager();
