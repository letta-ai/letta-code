// src/permissions/checker.ts
// Main permission checking logic

import { resolve } from "node:path";
import { getCurrentAgentId } from "../agent/context";
import { runPermissionRequestHooks } from "../hooks";
import { canonicalToolName, isShellToolName } from "./canonical";
import { cliPermissions } from "./cli";
import {
  type MatcherOptions,
  matchesBashPattern,
  matchesFilePattern,
  matchesToolPattern,
} from "./matcher";
import { permissionMode } from "./mode";
import { isMemoryDirCommand, isReadOnlyShellCommand } from "./readOnlyShell";
import { sessionPermissions } from "./session";
import type {
  PermissionCheckResult,
  PermissionCheckTrace,
  PermissionDecision,
  PermissionEngine,
  PermissionRules,
  PermissionTraceEvent,
} from "./types";

/**
 * Tools that don't require approval within working directory
 */
const WORKING_DIRECTORY_TOOLS_V2 = ["Read", "Glob", "Grep", "ListDir"];
const WORKING_DIRECTORY_TOOLS_V1 = [
  "Read",
  "Glob",
  "Grep",
  "read_file",
  "ReadFile",
  "list_dir",
  "ListDir",
  "grep_files",
  "GrepFiles",
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
const FILE_TOOLS_V2 = ["Read", "Write", "Edit", "Glob", "Grep", "ListDir"];
const FILE_TOOLS_V1 = [
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "read_file",
  "ReadFile",
  "list_dir",
  "ListDir",
  "grep_files",
  "GrepFiles",
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

type ToolArgs = Record<string, unknown>;

function envFlagEnabled(name: string): boolean {
  const value = process.env[name];
  if (!value) return false;
  return value === "1" || value.toLowerCase() === "true";
}

function isPermissionsV2Enabled(): boolean {
  const value = process.env.LETTA_PERMISSIONS_V2;
  if (!value) return true;
  return !(value === "0" || value.toLowerCase() === "false");
}

function shouldAttachTrace(result: PermissionCheckResult): boolean {
  if (envFlagEnabled("LETTA_PERMISSION_TRACE_ALL")) {
    return true;
  }
  if (!envFlagEnabled("LETTA_PERMISSION_TRACE")) {
    return false;
  }
  return result.decision === "ask" || result.decision === "deny";
}

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
export function checkPermission(
  toolName: string,
  toolArgs: ToolArgs,
  permissions: PermissionRules,
  workingDirectory: string = process.cwd(),
): PermissionCheckResult {
  const engine: PermissionEngine = isPermissionsV2Enabled() ? "v2" : "v1";
  const primary = checkPermissionForEngine(
    engine,
    toolName,
    toolArgs,
    permissions,
    workingDirectory,
  );

  let result: PermissionCheckResult = primary.result;
  const includeTrace = shouldAttachTrace(primary.result);
  if (includeTrace) {
    result = {
      ...result,
      trace: primary.trace,
    };
    console.error(
      `[permissions] trace ${JSON.stringify({
        toolName,
        engine,
        decision: primary.result.decision,
        matchedRule: primary.result.matchedRule,
        query: primary.trace.query,
        events: primary.trace.events,
      })}`,
    );
  }

  if (envFlagEnabled("LETTA_PERMISSIONS_DUAL_EVAL")) {
    const shadowEngine: PermissionEngine = engine === "v2" ? "v1" : "v2";
    const shadow = checkPermissionForEngine(
      shadowEngine,
      toolName,
      toolArgs,
      permissions,
      workingDirectory,
    );

    const mismatch =
      primary.result.decision !== shadow.result.decision ||
      primary.result.matchedRule !== shadow.result.matchedRule;

    if (mismatch) {
      console.error(
        `[permissions] dual-eval mismatch ${JSON.stringify({
          toolName,
          primary: {
            engine,
            decision: primary.result.decision,
            matchedRule: primary.result.matchedRule,
          },
          shadow: {
            engine: shadowEngine,
            decision: shadow.result.decision,
            matchedRule: shadow.result.matchedRule,
          },
        })}`,
      );
    }

    if (includeTrace && result.trace) {
      result.trace = {
        ...result.trace,
        shadow: {
          engine: shadowEngine,
          decision: shadow.result.decision,
          matchedRule: shadow.result.matchedRule,
        },
      };
    }
  }

  return result;
}

function createTrace(
  engine: PermissionEngine,
  toolName: string,
  canonicalTool: string,
  query: string,
): PermissionCheckTrace {
  return {
    engine,
    toolName,
    canonicalToolName: canonicalTool,
    query,
    events: [],
  };
}

function traceEvent(
  trace: PermissionCheckTrace,
  stage: string,
  message?: string,
  pattern?: string,
  matched?: boolean,
): void {
  const event: PermissionTraceEvent = { stage };
  if (message) event.message = message;
  if (pattern) event.pattern = pattern;
  if (matched !== undefined) event.matched = matched;
  trace.events.push(event);
}

function checkPermissionForEngine(
  engine: PermissionEngine,
  toolName: string,
  toolArgs: ToolArgs,
  permissions: PermissionRules,
  workingDirectory: string,
): { result: PermissionCheckResult; trace: PermissionCheckTrace } {
  const canonicalTool = canonicalToolName(toolName);
  const queryTool = engine === "v2" ? canonicalTool : toolName;
  const query = buildPermissionQuery(queryTool, toolArgs, engine);
  const trace = createTrace(engine, toolName, canonicalTool, query);
  const sessionRules = sessionPermissions.getRules();
  const workingDirectoryTools =
    engine === "v2" ? WORKING_DIRECTORY_TOOLS_V2 : WORKING_DIRECTORY_TOOLS_V1;

  if (permissions.deny) {
    for (const pattern of permissions.deny) {
      const matched = matchesPattern(
        toolName,
        query,
        pattern,
        workingDirectory,
        engine,
      );
      traceEvent(trace, "deny-rule", undefined, pattern, matched);
      if (matched) {
        return {
          result: {
            decision: "deny",
            matchedRule: pattern,
            reason: "Matched deny rule",
          },
          trace,
        };
      }
    }
  }

  const disallowedTools = cliPermissions.getDisallowedTools();
  for (const pattern of disallowedTools) {
    const matched = matchesPattern(
      toolName,
      query,
      pattern,
      workingDirectory,
      engine,
    );
    traceEvent(trace, "cli-disallow-rule", undefined, pattern, matched);
    if (matched) {
      return {
        result: {
          decision: "deny",
          matchedRule: `${pattern} (CLI)`,
          reason: "Matched --disallowedTools flag",
        },
        trace,
      };
    }
  }

  const modeOverride = permissionMode.checkModeOverride(toolName, toolArgs);
  if (modeOverride) {
    const currentMode = permissionMode.getMode();
    let reason = `Permission mode: ${currentMode}`;
    if (currentMode === "plan" && modeOverride === "deny") {
      const planFilePath = permissionMode.getPlanFilePath();
      reason =
        `Plan mode is active. You can only use read-only tools (Read, Grep, Glob, etc.) and write to the plan file. ` +
        `Write your plan to: ${planFilePath || "(error: plan file path not configured)"}. ` +
        `Use ExitPlanMode when your plan is ready for user approval.`;
    }
    traceEvent(trace, "mode-override", reason);
    return {
      result: {
        decision: modeOverride,
        matchedRule: `${currentMode} mode`,
        reason,
      },
      trace,
    };
  }

  const allowedTools = cliPermissions.getAllowedTools();
  for (const pattern of allowedTools) {
    const matched = matchesPattern(
      toolName,
      query,
      pattern,
      workingDirectory,
      engine,
    );
    traceEvent(trace, "cli-allow-rule", undefined, pattern, matched);
    if (matched) {
      return {
        result: {
          decision: "allow",
          matchedRule: `${pattern} (CLI)`,
          reason: "Matched --allowedTools flag",
        },
        trace,
      };
    }
  }

  if (toolName === "Skill") {
    traceEvent(trace, "skill-auto-allow", "Skill tool is always allowed");
    return {
      result: {
        decision: "allow",
        reason: "Skill tool is always allowed (read-only)",
      },
      trace,
    };
  }

  if (READ_ONLY_SHELL_TOOLS.has(toolName) || isShellToolName(canonicalTool)) {
    const shellCommand = extractShellCommand(toolArgs);
    if (shellCommand && isReadOnlyShellCommand(shellCommand)) {
      traceEvent(trace, "readonly-shell-auto-allow", "Read-only shell command");
      return {
        result: {
          decision: "allow",
          reason: "Read-only shell command",
        },
        trace,
      };
    }
    if (shellCommand) {
      try {
        const agentId = getCurrentAgentId();
        if (isMemoryDirCommand(shellCommand, agentId)) {
          traceEvent(
            trace,
            "memory-dir-auto-allow",
            "Agent memory directory operation",
          );
          return {
            result: {
              decision: "allow",
              reason: "Agent memory directory operation",
            },
            trace,
          };
        }
      } catch {
        traceEvent(trace, "memory-dir-check", "No agent context; skipped");
      }
    }
  }

  if (workingDirectoryTools.includes(queryTool)) {
    const filePath = extractFilePath(toolArgs);
    if (
      filePath &&
      isWithinAllowedDirectories(filePath, permissions, workingDirectory)
    ) {
      traceEvent(
        trace,
        "working-directory-auto-allow",
        `Allowed path: ${filePath}`,
      );
      return {
        result: {
          decision: "allow",
          reason: "Within working directory",
        },
        trace,
      };
    }
  }

  if (sessionRules.allow) {
    for (const pattern of sessionRules.allow) {
      const matched = matchesPattern(
        toolName,
        query,
        pattern,
        workingDirectory,
        engine,
      );
      traceEvent(trace, "session-allow-rule", undefined, pattern, matched);
      if (matched) {
        return {
          result: {
            decision: "allow",
            matchedRule: `${pattern} (session)`,
            reason: "Matched session allow rule",
          },
          trace,
        };
      }
    }
  }

  if (permissions.allow) {
    for (const pattern of permissions.allow) {
      const matched = matchesPattern(
        toolName,
        query,
        pattern,
        workingDirectory,
        engine,
      );
      traceEvent(trace, "allow-rule", undefined, pattern, matched);
      if (matched) {
        return {
          result: {
            decision: "allow",
            matchedRule: pattern,
            reason: "Matched allow rule",
          },
          trace,
        };
      }
    }
  }

  if (permissions.ask) {
    for (const pattern of permissions.ask) {
      const matched = matchesPattern(
        toolName,
        query,
        pattern,
        workingDirectory,
        engine,
      );
      traceEvent(trace, "ask-rule", undefined, pattern, matched);
      if (matched) {
        return {
          result: {
            decision: "ask",
            matchedRule: pattern,
            reason: "Matched ask rule",
          },
          trace,
        };
      }
    }
  }

  const defaultDecision = getDefaultDecision(toolName, toolArgs);
  traceEvent(trace, "default-decision", `Default: ${defaultDecision}`);
  return {
    result: {
      decision: defaultDecision,
      reason: "Default behavior for tool",
    },
    trace,
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
function buildPermissionQuery(
  toolName: string,
  toolArgs: ToolArgs,
  engine: PermissionEngine,
): string {
  switch (toolName) {
    // File tools: "ToolName(path/to/file)"
    case "Read":
    case "Write":
    case "Edit":
    case "Glob":
    case "Grep":
    case "ListDir":
    case "read_file":
    case "ReadFile":
    case "list_dir":
    case "grep_files":
    case "GrepFiles":
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
        typeof toolArgs.command === "string"
          ? toolArgs.command
          : Array.isArray(toolArgs.command)
            ? toolArgs.command.join(" ")
            : "";
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
    case "run_shell_command":
    case "RunShellCommand": {
      if (engine === "v1") {
        // Legacy behavior did not normalize this alias into Bash queries.
        return toolName;
      }
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
 * Check if query matches a permission pattern
 */
function matchesPattern(
  toolName: string,
  query: string,
  pattern: string,
  workingDirectory: string,
  engine: PermissionEngine,
): boolean {
  const matcherOptions: MatcherOptions =
    engine === "v2"
      ? { canonicalizeToolNames: true, allowBareToolFallback: true }
      : { canonicalizeToolNames: false, allowBareToolFallback: false };
  const toolForMatch = engine === "v2" ? canonicalToolName(toolName) : toolName;
  const fileTools = engine === "v2" ? FILE_TOOLS_V2 : FILE_TOOLS_V1;
  // File tools use glob matching
  if (fileTools.includes(toolForMatch)) {
    return matchesFilePattern(query, pattern, workingDirectory, matcherOptions);
  }

  // Bash uses prefix matching
  const legacyShellTool =
    engine === "v1" &&
    (toolForMatch === "Bash" ||
      toolForMatch === "shell" ||
      toolForMatch === "shell_command");
  const v2ShellTool = engine === "v2" && isShellToolName(toolName);
  if (toolForMatch === "Bash" || legacyShellTool || v2ShellTool) {
    return matchesBashPattern(query, pattern, matcherOptions);
  }

  // Other tools use simple name matching
  return matchesToolPattern(toolForMatch, pattern, matcherOptions);
}

/**
 * Subagent types that are read-only and safe to auto-approve.
 * These only have access to read-only tools (Glob, Grep, Read, LS, TaskOutput).
 * See: src/agent/subagents/builtin/*.md for definitions
 */
const READ_ONLY_SUBAGENT_TYPES = new Set([
  "explore", // Codebase exploration - Glob, Grep, Read, LS, TaskOutput
  "Explore",
  "plan", // Planning agent - Glob, Grep, Read, LS, TaskOutput
  "Plan",
  "recall", // Conversation history search - Skill, Bash, Read, TaskOutput
  "Recall",
  "reflection", // Memory reflection - reads history, writes to agent's own memory files
  "Reflection",
  "history-analyzer", // History analysis - reads history files, writes to agent memory
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
    "TaskOutput",
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
  const result = checkPermission(
    toolName,
    toolArgs,
    permissions,
    workingDirectory,
  );

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
