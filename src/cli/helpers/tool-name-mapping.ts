/**
 * Tool name mapping utilities for display purposes.
 * Centralizes tool name remapping logic used across the UI.
 */

import { isInteractiveApprovalTool } from "@/tools/interactive-policy";
import { MEMORY_TOOL_NAMES } from "@/tools/toolset";

/**
 * Maps internal tool names to user-friendly display names.
 * Handles multiple tool naming conventions:
 * - Anthropic toolset (snake_case and camelCase)
 * - Codex toolset (snake_case and PascalCase)
 */
export function getDisplayToolName(rawName: string): string {
  if (MEMORY_TOOL_NAMES.has(rawName)) return "Memory";

  // Anthropic toolset
  if (rawName === "write") return "Write";
  if (rawName === "edit" || rawName === "multi_edit") return "Update";
  if (rawName === "read") return "Read";
  if (rawName === "ViewImage") return "View Image";
  if (rawName === "bash") return "Bash";
  if (rawName === "grep" || rawName === "Grep") return "Search";
  if (rawName === "glob" || rawName === "Glob") return "Glob";
  if (rawName === "ls") return "LS";
  if (rawName === "todo_write" || rawName === "TodoWrite") return "TODO";
  if (rawName === "TaskCreate") return "Task Create";
  if (rawName === "TaskGet") return "Task Get";
  if (rawName === "TaskList") return "Task List";
  if (rawName === "TaskUpdate") return "Task Update";
  if (rawName === "AskUserQuestion") return "Question";

  // Codex tools
  if (rawName === "exec_command" || rawName === "write_stdin") return "Bash";
  if (rawName === "shell_command" || rawName === "shell") return "Bash";
  if (rawName === "read_file") return "Read";
  if (rawName === "list_dir") return "LS";
  if (rawName === "grep_files") return "Search";
  if (rawName === "web_search") return "Web Search";
  if (rawName === "fetch_webpage") return "Fetch Webpage";

  // Additional Codex tools
  if (rawName === "UpdatePlan") return "Planning";
  if (rawName === "ShellCommand" || rawName === "Shell") return "Bash";
  if (rawName === "ReadFile") return "Read";
  if (rawName === "ListDir") return "LS";
  if (rawName === "GrepFiles") return "Search";
  if (rawName === "ApplyPatch") return "Patch";
  if (rawName === "WebSearch") return "Web Search";
  if (rawName === "FetchWebpage") return "Fetch Webpage";

  // Additional tools
  if (rawName === "KillBash") return "Kill Bash";
  if (rawName === "BashOutput") return "Shell Output";
  if (rawName === "TaskOutput") return "Task Output";
  if (rawName === "MultiEdit") return "Update";

  // No mapping found, return as-is
  return rawName;
}

/**
 * Checks if a tool name represents a Task/subagent tool
 */
export function isTaskTool(name: string): boolean {
  return (
    name === "Task" || name === "task" || name === "Agent" || name === "agent"
  );
}

/**
 * Checks if a tool name represents a TODO/planning tool
 */
export function isTodoTool(rawName: string, displayName?: string): boolean {
  return (
    rawName === "todo_write" ||
    rawName === "TodoWrite" ||
    displayName === "TODO"
  );
}

/**
 * Checks if a tool name is part of the Task* CRUD family
 * (TaskCreate / TaskGet / TaskList / TaskUpdate).
 */
export function isTaskCrudTool(rawName: string): boolean {
  return (
    rawName === "TaskCreate" ||
    rawName === "TaskGet" ||
    rawName === "TaskList" ||
    rawName === "TaskUpdate"
  );
}

/**
 * Checks if a tool name represents a plan update tool
 */
export function isPlanTool(rawName: string, displayName?: string): boolean {
  return rawName === "UpdatePlan" || displayName === "Planning";
}

/**
 * Checks if a tool requires specialized inline UI instead of generic approval
 * rendering. File edit/write/patch tools and shell tools use their own views.
 */
export function isFancyUITool(name: string): boolean {
  return (
    name === "AskUserQuestion" ||
    // File edit/write/patch tools now render inline
    isFileEditTool(name) ||
    isFileWriteTool(name) ||
    isPatchTool(name) ||
    // Shell/bash tools now render inline
    isShellTool(name)
  );
}

/**
 * Checks if a tool always requires user interaction, even in unrestricted mode.
 * These are tools that fundamentally need user input to proceed:
 * - AskUserQuestion: needs user to answer questions
 *
 * Other tools (bash, file edits) should respect unrestricted mode and auto-approve.
 */
export function alwaysRequiresUserInput(name: string): boolean {
  return isInteractiveApprovalTool(name);
}

/**
 * Checks if a tool is a memory tool (server-side memory management)
 */
export function isMemoryTool(name: string): boolean {
  return MEMORY_TOOL_NAMES.has(name);
}

/**
 * Checks if a tool is a file edit tool (has old_string/new_string args)
 */
export function isFileEditTool(name: string): boolean {
  return (
    name === "edit" ||
    name === "Edit" ||
    name === "multi_edit" ||
    name === "MultiEdit"
  );
}

/**
 * Checks if a tool is a file write tool (has file_path/content args)
 */
export function isFileWriteTool(name: string): boolean {
  return name === "write" || name === "Write";
}

/**
 * Checks if a tool is a file read tool (has file_path arg)
 */
export function isFileReadTool(name: string): boolean {
  return (
    name === "read" ||
    name === "Read" ||
    name === "ViewImage" ||
    name === "ReadFile" ||
    name === "read_file"
  );
}

/**
 * Checks if a tool is a patch tool (applies unified diffs)
 */
export function isPatchTool(name: string): boolean {
  return name === "ApplyPatch";
}

/**
 * Checks if a tool is a shell/bash tool
 */
export function isShellTool(name: string): boolean {
  const n = name.toLowerCase();
  return (
    n === "bash" ||
    n === "shell" ||
    n === "shell_command" ||
    n === "shellcommand" ||
    n === "exec_command" ||
    n === "write_stdin"
  );
}

/**
 * Checks if a tool should use shell-style streaming output rendering.
 * Includes shell command tools plus TaskOutput/BashOutput pollers.
 */
export function isShellOutputTool(name: string): boolean {
  const n = name.toLowerCase();
  return isShellTool(name) || n === "taskoutput" || n === "bashoutput";
}

/**
 * Checks if a tool is a search/grep tool
 */
export function isSearchTool(name: string): boolean {
  return (
    name === "grep" ||
    name === "Grep" ||
    name === "grep_files" ||
    name === "GrepFiles"
  );
}

/**
 * Checks if a tool is web search.
 */
export function isWebSearchTool(name: string | undefined): boolean {
  return name === "web_search" || name === "WebSearch" || name === "webSearch";
}

/**
 * Checks if a tool is a glob tool
 */
export function isGlobTool(name: string): boolean {
  return name === "glob" || name === "Glob";
}
