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
  if (rawName === "bash") return "Bash";
  if (rawName === "grep") return "Grep";
  if (rawName === "glob") return "Glob";
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
  if (rawName === "grep_files") return "Grep";
  if (rawName === "apply_patch") return "Patch";

  // Codex toolset (PascalCase)
  if (rawName === "UpdatePlan") return "Planning";
  if (rawName === "ShellCommand" || rawName === "Shell") return "Bash";
  if (rawName === "ReadFile") return "Read";
  if (rawName === "ListDir") return "LS";
  if (rawName === "GrepFiles") return "Grep";
  if (rawName === "ApplyPatch") return "Patch";

  // Gemini toolset (snake_case)
  if (rawName === "run_shell_command") return "Bash";
  if (rawName === "read_file_gemini") return "Read";
  if (rawName === "list_directory") return "LS";
  if (rawName === "glob_gemini") return "Glob";
  if (rawName === "search_file_content") return "Grep";
  if (rawName === "write_file_gemini") return "Write";
  if (rawName === "write_todos") return "TODO";
  if (rawName === "read_many_files") return "Read Multiple";

  // Gemini toolset (PascalCase)
  if (rawName === "RunShellCommand") return "Bash";
  if (rawName === "ReadFileGemini") return "Read";
  if (rawName === "ListDirectory") return "LS";
  if (rawName === "GlobGemini") return "Glob";
  if (rawName === "SearchFileContent") return "Grep";
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
 */
export function isFancyUITool(name: string): boolean {
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
  return (
    name === "bash" ||
    name === "Bash" ||
    name === "shell" ||
    name === "Shell" ||
    name === "shell_command" ||
    name === "ShellCommand" ||
    name === "run_shell_command" ||
    name === "RunShellCommand"
  );
}
