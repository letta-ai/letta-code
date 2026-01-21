// src/permissions/checker.ts
// Main permission checking logic

import { resolve } from "node:path";
import { runPermissionRequestHooks } from "../hooks";
import { cliPermissions } from "./cli";
import {
  matchesBashPattern,
  matchesFilePattern,
  matchesToolPattern,
} from "./matcher";
import { permissionMode } from "./mode";
import { isReadOnlyShellCommand } from "./readOnlyShell";
import { sessionPermissions } from "./session";
import type {
  PermissionCheckResult,
  PermissionDecision,
  PermissionRules,
} from "./types";

/**
 * Tools that don't require approval within working directory
 */
const WORKING_DIRECTORY_TOOLS = [
  // Default/Anthropic toolset
  "Read",
  "Glob",
  "Grep",
  // Codex toolset
  "read_file",
  "ReadFile",
  "list_dir",
  "ListDir",
  "grep_files",
  "GrepFiles",
  // Gemini toolset
  "read_file_gemini",
  "ReadFileGemini",
  "glob_gemini",
  "GlobGemini",
  "list_directory",
  "ListDirectory",
  "search_file_content",
  "SearchFileContent",
  "read_many_files",
  "ReadManyFiles",
];
const READ_ONLY_SHELL_TOOLS = new Set([
  "Bash",
  "shell",
  "Shell",
  "shell_command",
  "ShellCommand",
  "run_shell_command",
  "RunShellCommand",
]);

/**
 * Check permission for a tool execution.
 *
 * Decision logic:
 * 1. Check deny rules from settings (first match wins) → DENY
 * 2. Check CLI disallowedTools (--disallowedTools flag) → DENY
 * 3. Check permission mode (--permission-mode flag) → ALLOW or DENY
 * 4. Check CLI allowedTools (--allowedTools flag) → ALLOW
 * 5. For Read/Glob/Grep within working directory → ALLOW
 * 6. Check session allow rules (first match wins) → ALLOW
 * 7. Check allow rules from settings (first match wins) → ALLOW
 * 8. Check ask rules from settings (first match wins) → ASK
 * 9. Fall back to default behavior for tool → ASK or ALLOW
 *
 * @param toolName - Name of the tool (e.g., "Read", "Bash", "Write")
 * @param toolArgs - Tool arguments (contains file paths, commands, etc.)
 * @param permissions - Loaded permission rules
 * @param workingDirectory - Current working directory
 */
type ToolArgs = Record<string, unknown>;

export function checkPermission(
  toolName: string,
  toolArgs: ToolArgs,
  permissions: PermissionRules,
  workingDirectory: string = process.cwd(),
): PermissionCheckResult {
  // Build permission query string
  const query = buildPermissionQuery(toolName, toolArgs);

  // Get session rules
  const sessionRules = sessionPermissions.getRules();

  // Check deny rules FIRST (highest priority - overrides everything including working directory)
  if (permissions.deny) {
    for (const pattern of permissions.deny) {
      if (matchesPattern(toolName, query, pattern, workingDirectory)) {
        return {
          decision: "deny",
          matchedRule: pattern,
          reason: "Matched deny rule",
        };
      }
    }
  }

  // Check CLI disallowedTools (second highest priority - overrides all allow rules)
  const disallowedTools = cliPermissions.getDisallowedTools();
  for (const pattern of disallowedTools) {
    if (matchesPattern(toolName, query, pattern, workingDirectory)) {
      return {
        decision: "deny",
        matchedRule: `${pattern} (CLI)`,
        reason: "Matched --disallowedTools flag",
      };
    }
  }

  // Check permission mode (applies before CLI allow rules but after deny rules)
  const modeOverride = permissionMode.checkModeOverride(toolName, toolArgs);
  if (modeOverride) {
    const currentMode = permissionMode.getMode();
    // Include plan file path and guidance in denial message for plan mode
    let reason = `Permission mode: ${currentMode}`;
    if (currentMode === "plan" && modeOverride === "deny") {
      const planFilePath = permissionMode.getPlanFilePath();
      // planFilePath should always be set when in plan mode - they're set together
      reason =
        `Plan mode is active. You can only use read-only tools (Read, Grep, Glob, etc.) and write to the plan file. ` +
        `Write your plan to: ${planFilePath || "(error: plan file path not configured)"}. ` +
        `Use ExitPlanMode when your plan is ready for user approval.`;
    }
    return {
      decision: modeOverride,
      matchedRule: `${currentMode} mode`,
      reason,
    };
  }

  // Check CLI allowedTools (third priority - overrides settings but not deny rules)
  const allowedTools = cliPermissions.getAllowedTools();
  for (const pattern of allowedTools) {
    if (matchesPattern(toolName, query, pattern, workingDirectory)) {
      return {
        decision: "allow",
        matchedRule: `${pattern} (CLI)`,
        reason: "Matched --allowedTools flag",
      };
    }
  }

  // Always allow Skill tool (read-only operation that loads skills from potentially external directories)
  if (toolName === "Skill") {
    return {
      decision: "allow",
      reason: "Skill tool is always allowed (read-only)",
    };
  }

  if (READ_ONLY_SHELL_TOOLS.has(toolName)) {
    const shellCommand = extractShellCommand(toolArgs);
    if (shellCommand && isReadOnlyShellCommand(shellCommand)) {
      return {
        decision: "allow",
        reason: "Read-only shell command",
      };
    }
  }

  // After checking CLI overrides, check if Read/Glob/Grep within working directory
  if (WORKING_DIRECTORY_TOOLS.includes(toolName)) {
    const filePath = extractFilePath(toolArgs);
    if (
      filePath &&
      isWithinAllowedDirectories(filePath, permissions, workingDirectory)
    ) {
      return {
        decision: "allow",
        reason: "Within working directory",
      };
    }
  }

  // Check session allow rules (higher precedence than persisted allow)
  if (sessionRules.allow) {
    for (const pattern of sessionRules.allow) {
      if (matchesPattern(toolName, query, pattern, workingDirectory)) {
        return {
          decision: "allow",
          matchedRule: `${pattern} (session)`,
          reason: "Matched session allow rule",
        };
      }
    }
  }

  // Check persisted allow rules
  if (permissions.allow) {
    for (const pattern of permissions.allow) {
      if (matchesPattern(toolName, query, pattern, workingDirectory)) {
        return {
          decision: "allow",
          matchedRule: pattern,
          reason: "Matched allow rule",
        };
      }
    }
  }

  // Check ask rules
  if (permissions.ask) {
    for (const pattern of permissions.ask) {
      if (matchesPattern(toolName, query, pattern, workingDirectory)) {
        return {
          decision: "ask",
          matchedRule: pattern,
          reason: "Matched ask rule",
        };
      }
    }
  }

  // Fall back to tool defaults
  return {
    decision: getDefaultDecision(toolName, toolArgs),
    reason: "Default behavior for tool",
  };
}

/**
 * Extract file path from tool arguments
 */
function extractFilePath(toolArgs: ToolArgs): string | null {
  // Different tools use different parameter names
  if (typeof toolArgs.file_path === "string" && toolArgs.file_path.length > 0) {
    return toolArgs.file_path;
  }
  if (typeof toolArgs.path === "string" && toolArgs.path.length > 0) {
    return toolArgs.path;
  }
  if (
    typeof toolArgs.notebook_path === "string" &&
    toolArgs.notebook_path.length > 0
  ) {
    return toolArgs.notebook_path;
  }
  return null;
}

/**
 * Check if file path is within allowed directories
 * (working directory + additionalDirectories)
 */
function isWithinAllowedDirectories(
  filePath: string,
  permissions: PermissionRules,
  workingDirectory: string,
): boolean {
  const absolutePath = resolve(workingDirectory, filePath);

  // Check if within working directory
  if (absolutePath.startsWith(workingDirectory)) {
    return true;
  }

  // Check additionalDirectories
  if (permissions.additionalDirectories) {
    for (const dir of permissions.additionalDirectories) {
      const resolvedDir = resolve(workingDirectory, dir);
      if (absolutePath.startsWith(resolvedDir)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Build permission query string for a tool execution
 */
function buildPermissionQuery(toolName: string, toolArgs: ToolArgs): string {
  switch (toolName) {
    // File tools: "ToolName(path/to/file)"
    case "Read":
    case "Write":
    case "Edit":
    case "Glob":
    case "Grep":
    // Codex file tools
    case "read_file":
    case "ReadFile":
    case "list_dir":
    case "ListDir":
    case "grep_files":
    case "GrepFiles":
    // Gemini file tools
    case "read_file_gemini":
    case "ReadFileGemini":
    case "write_file_gemini":
    case "WriteFileGemini":
    case "glob_gemini":
    case "GlobGemini":
    case "list_directory":
    case "ListDirectory":
    case "search_file_content":
    case "SearchFileContent":
    case "read_many_files":
    case "ReadManyFiles": {
      const filePath = extractFilePath(toolArgs);
      return filePath ? `${toolName}(${filePath})` : toolName;
    }

    case "Bash": {
      // Bash: "Bash(command with args)"
      const command =
        typeof toolArgs.command === "string" ? toolArgs.command : "";
      return `Bash(${command})`;
    }
    case "shell":
    case "shell_command": {
      const command =
        typeof toolArgs.command === "string"
          ? toolArgs.command
          : Array.isArray(toolArgs.command)
            ? toolArgs.command.join(" ")
            : "";
      return `Bash(${command})`;
    }

    default:
      // Other tools: just the tool name
      return toolName;
  }
}

function extractShellCommand(toolArgs: ToolArgs): string | string[] | null {
  const command = toolArgs.command;
  if (typeof command === "string" || Array.isArray(command)) {
    return command;
  }
  return null;
}

/**
 * File tools that use glob matching for permissions
 */
const FILE_TOOLS = [
  // Default/Anthropic toolset
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  // Codex toolset
  "read_file",
  "ReadFile",
  "list_dir",
  "ListDir",
  "grep_files",
  "GrepFiles",
  // Gemini toolset
  "read_file_gemini",
  "ReadFileGemini",
  "write_file_gemini",
  "WriteFileGemini",
  "glob_gemini",
  "GlobGemini",
  "list_directory",
  "ListDirectory",
  "search_file_content",
  "SearchFileContent",
  "read_many_files",
  "ReadManyFiles",
];

/**
 * Check if query matches a permission pattern
 */
function matchesPattern(
  toolName: string,
  query: string,
  pattern: string,
  workingDirectory: string,
): boolean {
  // File tools use glob matching
  if (FILE_TOOLS.includes(toolName)) {
    return matchesFilePattern(query, pattern, workingDirectory);
  }

  // Bash uses prefix matching
  if (
    toolName === "Bash" ||
    toolName === "shell" ||
    toolName === "shell_command"
  ) {
    return matchesBashPattern(query, pattern);
  }

  // Other tools use simple name matching
  return matchesToolPattern(toolName, pattern);
}

/**
 * Subagent types that are read-only and safe to auto-approve.
 * These only have access to read-only tools (Glob, Grep, Read, LS, BashOutput).
 * See: src/agent/subagents/builtin/*.md for definitions
 */
const READ_ONLY_SUBAGENT_TYPES = new Set([
  "explore", // Codebase exploration - Glob, Grep, Read, LS, BashOutput
  "Explore",
  "plan", // Planning agent - Glob, Grep, Read, LS, BashOutput
  "Plan",
  "recall", // Conversation history search - Skill, Bash, Read, BashOutput
  "Recall",
]);

/**
 * Get default decision for a tool (when no rules match)
 */
function getDefaultDecision(
  toolName: string,
  toolArgs?: ToolArgs,
): PermissionDecision {
  // Check TOOL_PERMISSIONS to determine if tool requires approval
  // Import is async so we need to do this synchronously - get the permissions from manager
  // For now, use a hardcoded check that matches TOOL_PERMISSIONS configuration
  const autoAllowTools = [
    // Anthropic toolset - tools that don't require approval
    "Read",
    "Glob",
    "Grep",
    "TodoWrite",
    "BashOutput",
    "LS",
    // Codex toolset (snake_case) - tools that don't require approval
    "read_file",
    "list_dir",
    "grep_files",
    "update_plan",
    // Codex toolset (PascalCase) - tools that don't require approval
    "ReadFile",
    "ListDir",
    "GrepFiles",
    "UpdatePlan",
    // Gemini toolset (snake_case) - tools that don't require approval
    "read_file_gemini",
    "list_directory",
    "glob_gemini",
    "search_file_content",
    "write_todos",
    "read_many_files",
    // Gemini toolset (PascalCase) - tools that don't require approval
    "ReadFileGemini",
    "ListDirectory",
    "GlobGemini",
    "SearchFileContent",
    "WriteTodos",
    "ReadManyFiles",
  ];

  if (autoAllowTools.includes(toolName)) {
    return "allow";
  }

  // Task tool: auto-approve read-only subagent types
  if (toolName === "Task" || toolName === "task") {
    const subagentType =
      typeof toolArgs?.subagent_type === "string" ? toolArgs.subagent_type : "";
    if (READ_ONLY_SUBAGENT_TYPES.has(subagentType)) {
      return "allow";
    }
    // Non-read-only subagent types require approval
    return "ask";
  }

  // Everything else defaults to ask
  return "ask";
}

/**
 * Check permission for a tool execution with hook support.
 * When the decision would be "ask" (show permission dialog), runs PermissionRequest hooks
 * which can auto-allow (exit 0) or auto-deny (exit 2) without showing UI.
 *
 * @param toolName - Name of the tool
 * @param toolArgs - Tool arguments
 * @param permissions - Loaded permission rules
 * @param workingDirectory - Current working directory
 */
export async function checkPermissionWithHooks(
  toolName: string,
  toolArgs: ToolArgs,
  permissions: PermissionRules,
  workingDirectory: string = process.cwd(),
): Promise<PermissionCheckResult> {
  // First, check permission using normal rules
  const result = checkPermission(toolName, toolArgs, permissions, workingDirectory);

  // If decision is "ask", run PermissionRequest hooks to see if they auto-allow/deny
  if (result.decision === "ask") {
    const hookResult = await runPermissionRequestHooks(
      toolName,
      toolArgs,
      "ask",
      undefined,
      workingDirectory,
    );

    // If hook blocked (exit code 2), deny the permission
    if (hookResult.blocked) {
      const feedback = hookResult.feedback.join("\n") || "Denied by hook";
      return {
        decision: "deny",
        matchedRule: "PermissionRequest hook",
        reason: feedback,
      };
    }

    // If hook succeeded (exit code 0 from any hook), allow the permission
    // Check if any hook ran and returned success
    const anyHookAllowed = hookResult.results.some(
      (r) => r.exitCode === 0 && !r.timedOut && !r.error,
    );
    if (anyHookAllowed) {
      return {
        decision: "allow",
        matchedRule: "PermissionRequest hook",
        reason: "Allowed by hook",
      };
    }
  }

  return result;
}
