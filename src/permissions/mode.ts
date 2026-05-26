// src/permissions/mode.ts
// Permission mode management (unrestricted, standard, acceptEdits, memory)

import { extractApplyPatchPaths } from "./cross-agent-guard";
import { classifyMemoryBashDenial } from "./memory-denial-reason";
import {
  isPathWithinRoots,
  resolveAllowedMemoryRoots,
  resolveMemoryTargetPath,
} from "./memory-paths";
import {
  isReadOnlyShellCommand,
  isScopedMemoryShellCommand,
} from "./read-only-shell";

export type PermissionMode =
  | "standard"
  | "acceptEdits"
  | "memory"
  | "unrestricted";

/** The default starting permission mode. */
export const DEFAULT_PERMISSION_MODE: PermissionMode = "unrestricted";

/** All valid current permission mode values. */
export const VALID_PERMISSION_MODES: readonly PermissionMode[] = [
  "unrestricted",
  "standard",
  "acceptEdits",
  "memory",
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
  if (value === "bypassPermissions" || value === "fullAccess")
    return "unrestricted";
  return null;
}

/**
 * Result of a permission-mode check. Includes a decision and an optional
 * `reason` string the caller can surface to the agent (e.g. denial guidance
 * like "use heredoc instead of $()"). When `reason` is omitted the caller
 * falls back to a generic `"Permission mode: {mode}"` message.
 */
export interface ModeOverrideResult {
  decision: "allow" | "deny";
  reason?: string;
}

// Use globalThis to ensure singleton across bundle
// This prevents Bun's bundler from creating duplicate instances of the mode manager
const MODE_KEY = Symbol.for("@letta/permissionMode");

type GlobalWithMode = typeof globalThis & {
  [MODE_KEY]: PermissionMode;
};

function everyResolvedTargetIsWithinRoots(
  candidatePaths: string[],
  roots: string[],
  workingDirectory: string,
): boolean {
  return (
    candidatePaths.length > 0 &&
    candidatePaths.every((path) => {
      const resolvedPath = resolveMemoryTargetPath(path, workingDirectory);
      return resolvedPath ? isPathWithinRoots(resolvedPath, roots) : false;
    })
  );
}

/**
 * Build a denial reason for write/edit tools whose target is outside the
 * allowed memory roots (or where the tool was invoked without any target
 * path at all). Names the offending path and the allowed roots so the
 * agent can correct course.
 */
function buildWriteOutsideRootsReason(
  candidatePaths: string[],
  allowedRoots: string[],
): string {
  if (allowedRoots.length === 0) {
    return (
      "Memory mode requires $MEMORY_DIR to be set so write targets can be " +
      "resolved against an allowed memory root."
    );
  }
  const rootsList = allowedRoots.join(", ");
  if (candidatePaths.length === 0) {
    return (
      `Memory mode requires Write/Edit targets to be inside $MEMORY_DIR ` +
      `(${rootsList}). The tool was invoked without a resolvable target path.`
    );
  }
  const targetList = candidatePaths.join(", ");
  return (
    `Memory mode requires Write/Edit targets to be inside $MEMORY_DIR. ` +
    `Got: ${targetList}. Allowed roots: ${rootsList}.`
  );
}

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
   *
   * When returning a deny decision, the result may include a `reason` string
   * to help the agent recover (e.g. "use heredoc instead of $()"). If
   * `reason` is omitted callers fall back to a generic
   * `"Permission mode: {mode}"` message.
   */
  checkModeOverride(
    toolName: string,
    toolArgs?: Record<string, unknown>,
    workingDirectory: string = process.cwd(),
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
          "exec_command",
          "write_stdin",
          "run_shell_command",
          "RunShellCommand",
          "run_shell_command_gemini",
          "RunShellCommandGemini",
        ];

        if (allowedReadOnlyTools.includes(toolName)) {
          return { decision: "allow" };
        }

        if (toolName === "memory_apply_patch") {
          if (allowedMemoryRoots.length > 0) {
            return { decision: "allow" };
          }
          return {
            decision: "deny",
            reason:
              "Memory mode requires $MEMORY_DIR to be set so the " +
              "apply-patch target can be resolved.",
          };
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
            return { decision: "allow" };
          }

          return {
            decision: "deny",
            reason: buildWriteOutsideRootsReason(
              candidatePaths,
              allowedMemoryRoots,
            ),
          };
        }

        if (shellTools.includes(toolName)) {
          if (toolName === "write_stdin") {
            return toolArgs?.chars
              ? {
                  decision: "deny",
                  reason:
                    "Memory mode does not allow writing stdin to shell sessions.",
                }
              : { decision: "allow" };
          }

          const command =
            (toolArgs?.cmd as string | undefined) ??
            (toolArgs?.command as string | string[] | undefined);
          if (
            command &&
            isReadOnlyShellCommand(command, { allowExternalPaths: true })
          ) {
            return { decision: "allow" };
          }

          if (
            command &&
            allowedMemoryRoots.length > 0 &&
            isScopedMemoryShellCommand(command, allowedMemoryRoots, {
              workingDirectory,
            })
          ) {
            return { decision: "allow" };
          }

          if (!command) {
            return {
              decision: "deny",
              reason:
                "Memory mode requires the Bash tool to be invoked with a " +
                "`command` argument.",
            };
          }

          const { reason } = classifyMemoryBashDenial(
            command,
            allowedMemoryRoots,
            { workingDirectory },
          );
          return { decision: "deny", reason };
        }

        return {
          decision: "deny",
          reason:
            `Memory mode only permits read-only tools, Edit/Write to paths ` +
            `under $MEMORY_DIR, and scoped Bash. Tool '${toolName}' is not ` +
            `available.`,
        };
      }

      case "standard":
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
    this.currentMode = DEFAULT_PERMISSION_MODE;
  }
}

// Singleton instance
export const permissionMode = new PermissionModeManager();
