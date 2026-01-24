/**
 * Tool name mapping utilities for display purposes.
 * Centralizes tool name remapping logic used across the UI.
 */

/**
 * Maps internal tool names to user-friendly display names.
 * Handles multiple tool naming conventions:
 * - Anthropic toolset (snake_case and camelCase)
 * - Codex toolset (snake_case and PascalCase)
 * - Gemini toolset (snake_case and PascalCase)
 */
export function getDisplayToolName(rawName: string): string {
  // Anthropic toolset
  if (rawName === "write") return "Write";
  if (rawName === "edit" || rawName === "multi_edit") return "Update";
  if (rawName === "read") return "Read";
  if (rawName === "view_image" || rawName === "ViewImage") return "View Image";
  if (rawName === "bash") return "Bash";
  if (rawName === "grep" || rawName === "Grep") return "Search";
  if (rawName === "glob" || rawName === "Glob") return "Glob";
  if (rawName === "ls") return "LS";
  if (rawName === "todo_write" || rawName === "TodoWrite") return "TODO";
  if (rawName === "EnterPlanMode" || rawName === "ExitPlanMode")
    return "Planning";
  if (rawName === "AskUserQuestion") return "Question";

  // Codex toolset (snake_case)
  if (rawName === "update_plan") return "Planning";
  if (rawName === "shell_command" || rawName === "shell") return "Bash";
  if (rawName === "read_file") return "Read";
  if (rawName === "list_dir") return "LS";
  if (rawName === "grep_files") return "Search";
  if (rawName === "apply_patch") return "Patch";

  // Codex toolset (PascalCase)
  if (rawName === "UpdatePlan") return "Planning";
  if (rawName === "ShellCommand" || rawName === "Shell") return "Bash";
  if (rawName === "ReadFile") return "Read";
  if (rawName === "ListDir") return "LS";
  if (rawName === "GrepFiles") return "Search";
  if (rawName === "ApplyPatch") return "Patch";

  // Gemini toolset (snake_case)
  if (rawName === "run_shell_command") return "Bash";
  if (rawName === "read_file_gemini") return "Read";
  if (rawName === "list_directory") return "LS";
  if (rawName === "glob_gemini") return "Glob";
  if (rawName === "search_file_content") return "Search";
  if (rawName === "write_file_gemini") return "Write";
  if (rawName === "write_todos") return "TODO";
  if (rawName === "read_many_files") return "Read Multiple";

  // Gemini toolset (PascalCase)
  if (rawName === "RunShellCommand") return "Bash";
  if (rawName === "ReadFileGemini") return "Read";
  if (rawName === "ListDirectory") return "LS";
  if (rawName === "GlobGemini") return "Glob";
  if (rawName === "SearchFileContent") return "Search";
  if (rawName === "WriteFileGemini") return "Write";
  if (rawName === "WriteTodos") return "TODO";
  if (rawName === "ReadManyFiles") return "Read Multiple";

  // Additional tools
  if (rawName === "Replace" || rawName === "replace") return "Update";
  if (rawName === "WriteFile" || rawName === "write_file") return "Write";
  if (rawName === "KillBash") return "Kill Bash";
  if (rawName === "BashOutput") return "Shell Output";
  if (rawName === "MultiEdit") return "Update";

  // No mapping found, return as-is
  return rawName;
}

/**
 * Checks if a tool name represents a Task/subagent tool
 */
export function isTaskTool(name: string): boolean {
  return name === "Task" || name === "task";
}

/**
 * Checks if a tool name represents a TODO/planning tool
 */
export function isTodoTool(rawName: string, displayName?: string): boolean {
  return (
    rawName === "todo_write" ||
    rawName === "TodoWrite" ||
    rawName === "write_todos" ||
    rawName === "WriteTodos" ||
    displayName === "TODO"
  );
}

/**
 * Checks if a tool name represents a plan update tool
 */
export function isPlanTool(rawName: string, displayName?: string): boolean {
  return (
    rawName === "update_plan" ||
    rawName === "UpdatePlan" ||
    displayName === "Planning"
  );
}

/**
 * Checks if a tool requires a specialized UI dialog instead of standard approval
 * Note: ExitPlanMode, file edit/write/patch tools, and shell tools now render inline
 * (not overlay), but still need this flag to bypass the standard ApprovalDialog rendering
 */
export function isFancyUITool(name: string): boolean {
  return (
    name === "AskUserQuestion" ||
    name === "EnterPlanMode" ||
    name === "ExitPlanMode" ||
    // File edit/write/patch tools now render inline
    isFileEditTool(name) ||
    isFileWriteTool(name) ||
    isPatchTool(name) ||
    // Shell/bash tools now render inline
    isShellTool(name)
  );
}

/**
 * Checks if a tool always requires user interaction, even in yolo mode.
 * These are tools that fundamentally need user input to proceed:
 * - AskUserQuestion: needs user to answer questions
 * - EnterPlanMode: needs user to approve entering plan mode
 * - ExitPlanMode: needs user to approve the plan
 *
 * Other tools (bash, file edits) should respect yolo mode and auto-approve.
 */
export function alwaysRequiresUserInput(name: string): boolean {
  return (
    name === "AskUserQuestion" ||
    name === "EnterPlanMode" ||
    name === "ExitPlanMode"
  );
}

/**
 * Checks if a tool is a memory tool (server-side memory management)
 */
export function isMemoryTool(name: string): boolean {
  return name === "memory" || name === "memory_apply_patch";
}

/**
 * Checks if a tool is a file edit tool (has old_string/new_string args)
 */
export function isFileEditTool(name: string): boolean {
  return (
    name === "edit" ||
    name === "Edit" ||
    name === "multi_edit" ||
    name === "MultiEdit" ||
    name === "Replace" ||
    name === "replace"
  );
}

/**
 * Checks if a tool is a file write tool (has file_path/content args)
 */
export function isFileWriteTool(name: string): boolean {
  return (
    name === "write" ||
    name === "Write" ||
    name === "WriteFile" ||
    name === "write_file" ||
    name === "write_file_gemini" ||
    name === "WriteFileGemini"
  );
}

/**
 * Checks if a tool is a file read tool (has file_path arg)
 */
export function isFileReadTool(name: string): boolean {
  return (
    name === "read" ||
    name === "Read" ||
    name === "view_image" ||
    name === "ViewImage" ||
    name === "ReadFile" ||
    name === "read_file" ||
    name === "read_file_gemini" ||
    name === "ReadFileGemini" ||
    name === "read_many_files" ||
    name === "ReadManyFiles"
  );
}

/**
 * Checks if a tool is a patch tool (applies unified diffs)
 */
export function isPatchTool(name: string): boolean {
  return name === "apply_patch" || name === "ApplyPatch";
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
    n === "run_shell_command" ||
    n === "runshellcommand"
  );
}

/**
 * Checks if a tool is a search/grep tool
 */
export function isSearchTool(name: string): boolean {
  return (
    name === "grep" ||
    name === "Grep" ||
    name === "grep_files" ||
    name === "GrepFiles" ||
    name === "search_file_content" ||
    name === "SearchFileContent"
  );
}

/**
 * Checks if a tool is a glob tool
 */
export function isGlobTool(name: string): boolean {
  return (
    name === "glob" ||
    name === "Glob" ||
    name === "glob_gemini" ||
    name === "GlobGemini"
  );
}
