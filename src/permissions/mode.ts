// src/permissions/mode.ts
// Permission mode management (default, acceptEdits, plan, memory, bypassPermissions)

import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { extractApplyPatchPaths } from "./crossAgentGuard";
import {
  isPathWithinRoots,
  resolveAllowedMemoryRoots,
  resolveScopedTargetPath,
} from "./memoryScope";
import {
  isReadOnlyShellCommand,
  isScopedMemoryShellCommand,
} from "./readOnlyShell";
import { unwrapShellLauncherCommand } from "./shell-command-normalization";

export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "plan"
  | "memory"
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

function everyResolvedTargetIsWithinRoots(
  candidatePaths: string[],
  roots: string[],
  workingDirectory: string,
): boolean {
  return (
    candidatePaths.length > 0 &&
    candidatePaths.every((path) => {
      const resolvedPath = resolveScopedTargetPath(path, workingDirectory);
      return resolvedPath ? isPathWithinRoots(resolvedPath, roots) : false;
    })
  );
}

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

function resolvePlanTargetPath(
  targetPath: string,
  workingDirectory: string,
): string | null {
  return resolveScopedTargetPath(targetPath, workingDirectory);
}

function isPathInPlansDir(path: string, plansDir: string): boolean {
  if (!path.endsWith(".md")) return false;
  const rel = relative(plansDir, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function stripMatchingQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) {
    return trimmed;
  }

  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === '"' || first === "'") && last === first) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Detect commands that are exclusively a heredoc write to a file:
 *   cat > /path/to/file <<'EOF'\n...\nEOF
 *   cat <<'EOF' > /path/to/file\n...\nEOF
 *
 * Returns the target file path when recognized, otherwise null.
 */
function extractPlanFileWritePathFromShellCommand(
  command: string | string[] | undefined,
): string | null {
  if (!command) {
    return null;
  }

  const commandString =
    typeof command === "string" ? command : (command.join(" ") ?? "");
  const normalizedCommand = unwrapShellLauncherCommand(commandString).trim();
  if (!normalizedCommand) {
    return null;
  }

  const lines = normalizedCommand.split(/\r?\n/);
  const firstLine = lines[0]?.trim() ?? "";
  if (!firstLine) {
    return null;
  }

  const firstLineMatch = firstLine.match(
    /^cat\s+(?:>\s*(?<path1>"[^"]+"|'[^']+'|\S+)\s+<<-?\s*(?<delim1>"[^"]+"|'[^']+'|\S+)|<<-?\s*(?<delim2>"[^"]+"|'[^']+'|\S+)\s+>\s*(?<path2>"[^"]+"|'[^']+'|\S+))\s*$/,
  );
  if (!firstLineMatch?.groups) {
    return null;
  }

  const rawPath = firstLineMatch.groups.path1 || firstLineMatch.groups.path2;
  const rawDelim = firstLineMatch.groups.delim1 || firstLineMatch.groups.delim2;

  if (!rawPath || !rawDelim) {
    return null;
  }

  const delimiter = stripMatchingQuotes(rawDelim);
  if (!delimiter) {
    return null;
  }

  // Find heredoc terminator line and ensure nothing non-whitespace follows it.
  let terminatorLine = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if ((lines[i] ?? "") === delimiter) {
      terminatorLine = i;
      break;
    }
  }
  if (terminatorLine === -1) {
    return null;
  }

  for (let i = terminatorLine + 1; i < lines.length; i += 1) {
    if ((lines[i] ?? "").trim().length > 0) {
      return null;
    }
  }

  return stripMatchingQuotes(rawPath);
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
   * Check if a tool should be auto-allowed based on current mode.
   * Accepts explicit `mode` and `planFilePath` overrides so callers with a
   * scoped PermissionModeState (listener/remote mode) can bypass the global
   * singleton without requiring a temporary mutation of global state.
   * Returns null if mode doesn't apply to this tool.
   */
  checkModeOverride(
    toolName: string,
    toolArgs?: Record<string, unknown>,
    workingDirectory: string = process.cwd(),
    modeOverride?: PermissionMode,
    planFilePathOverride?: string | null,
  ): "allow" | "deny" | null {
    const effectiveMode = modeOverride ?? this.currentMode;
    const _effectivePlanFilePath =
      planFilePathOverride !== undefined
        ? planFilePathOverride
        : this.getPlanFilePath();
    switch (effectiveMode) {
      case "bypassPermissions":
        // ExitPlanMode always requires human approval, even in yolo mode
        if (toolName === "ExitPlanMode" || toolName === "exit_plan_mode") {
          return null;
        }
        // Auto-allow everything else (except explicit deny rules checked earlier)
        return "allow";

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
          // Image tools (read-only)
          "ViewImage",
          "view_image",
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
          "task_output",
          // Codex toolset (PascalCase)
          "ReadFile",
          "ListDir",
          "GrepFiles",
          "UpdatePlan",
          "TaskOutput",
          // Gemini toolset (snake_case)
          "read_file_gemini",
          "glob_gemini",
          "list_directory",
          "search_file_content",
          "write_todos",
          "read_many_files",
          // Gemini toolset (PascalCase)
          "ReadFileGemini",
          "GlobGemini",
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
          "memory_apply_patch",
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
          const targetPath =
            (toolArgs?.file_path as string) || (toolArgs?.path as string);
          let candidatePaths: string[] = [];

          // ApplyPatch/apply_patch: extract all file directives.
          if (
            (toolName === "ApplyPatch" ||
              toolName === "apply_patch" ||
              toolName === "memory_apply_patch") &&
            toolArgs?.input
          ) {
            const input = toolArgs.input as string;
            candidatePaths = extractApplyPatchPaths(input);
          } else if (typeof targetPath === "string") {
            candidatePaths = [targetPath];
          }

          // Allow only if every target resolves to a .md file within ~/.letta/plans.
          if (
            candidatePaths.length > 0 &&
            candidatePaths.every((path) => {
              const resolvedPath = resolvePlanTargetPath(
                path,
                workingDirectory,
              );
              return resolvedPath
                ? isPathInPlansDir(resolvedPath, plansDir)
                : false;
            })
          ) {
            return "allow";
          }
        }

        // Allow Task tool with read-only subagent types
        // These subagents only have access to read-only tools (Glob, Grep, Read, LS, TaskOutput)
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
          "run_shell_command_gemini",
          "RunShellCommandGemini",
        ];
        if (shellTools.includes(toolName)) {
          const command = toolArgs?.command as string | string[] | undefined;
          if (
            command &&
            isReadOnlyShellCommand(command, { allowExternalPaths: true })
          ) {
            return "allow";
          }

          // Special case: allow shell heredoc writes when they ONLY target
          // a markdown file in ~/.letta/plans/.
          const planWritePath =
            extractPlanFileWritePathFromShellCommand(command);
          if (planWritePath) {
            const plansDir = join(homedir(), ".letta", "plans");
            const resolvedPath = resolvePlanTargetPath(
              planWritePath,
              workingDirectory,
            );

            if (resolvedPath && isPathInPlansDir(resolvedPath, plansDir)) {
              return "allow";
            }
          }
        }

        // Everything else denied in plan mode
        return "deny";
      }

      case "memory": {
        const allowedMemoryRoots = resolveAllowedMemoryRoots().roots;
        const allowedReadOnlyTools = [
          // Anthropic toolset
          "Read",
          "Glob",
          "Grep",
          "NotebookRead",
          // Image / task output / skills
          "ViewImage",
          "view_image",
          "TaskOutput",
          "task_output",
          "Skill",
          "skill",
          // Codex toolset
          "read_file",
          "list_dir",
          "grep_files",
          "ReadFile",
          "ListDir",
          "GrepFiles",
          // Gemini toolset
          "read_file_gemini",
          "glob_gemini",
          "list_directory",
          "search_file_content",
          "read_many_files",
          "ReadFileGemini",
          "GlobGemini",
          "ListDirectory",
          "SearchFileContent",
          "ReadManyFiles",
        ];
        const writeTools = [
          "Write",
          "Edit",
          "MultiEdit",
          "NotebookEdit",
          "apply_patch",
          "ApplyPatch",
          "replace",
          "Replace",
          "write_file",
          "WriteFile",
          "write_file_gemini",
          "WriteFileGemini",
        ];
        const shellTools = [
          "Bash",
          "shell",
          "Shell",
          "shell_command",
          "ShellCommand",
          "run_shell_command",
          "RunShellCommand",
          "run_shell_command_gemini",
          "RunShellCommandGemini",
        ];

        if (allowedReadOnlyTools.includes(toolName)) {
          return "allow";
        }

        if (toolName === "memory_apply_patch") {
          return allowedMemoryRoots.length > 0 ? "allow" : "deny";
        }

        if (writeTools.includes(toolName)) {
          const targetPath =
            (toolArgs?.file_path as string) || (toolArgs?.path as string);
          let candidatePaths: string[] = [];

          if (
            (toolName === "ApplyPatch" || toolName === "apply_patch") &&
            toolArgs?.input
          ) {
            candidatePaths = extractApplyPatchPaths(toolArgs.input as string);
          } else if (typeof targetPath === "string") {
            candidatePaths = [targetPath];
          }

          if (
            allowedMemoryRoots.length > 0 &&
            everyResolvedTargetIsWithinRoots(
              candidatePaths,
              allowedMemoryRoots,
              workingDirectory,
            )
          ) {
            return "allow";
          }

          return "deny";
        }

        if (shellTools.includes(toolName)) {
          const command = toolArgs?.command as string | string[] | undefined;
          if (
            command &&
            isReadOnlyShellCommand(command, { allowExternalPaths: true })
          ) {
            return "allow";
          }

          if (
            command &&
            allowedMemoryRoots.length > 0 &&
            isScopedMemoryShellCommand(command, allowedMemoryRoots, {
              workingDirectory,
            })
          ) {
            return "allow";
          }

          return "deny";
        }

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
