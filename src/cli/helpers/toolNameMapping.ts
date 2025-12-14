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
  if (rawName === "edit" || rawName === "multi_edit") return "Edit";
  if (rawName === "read") return "Read";
  if (rawName === "bash") return "Bash";
  if (rawName === "grep") return "Grep";
  if (rawName === "glob") return "Glob";
  if (rawName === "ls") return "LS";
  if (rawName === "todo_write" || rawName === "TodoWrite") return "TODO";
  if (rawName === "EnterPlanMode" || rawName === "ExitPlanMode") return "Planning";
  if (rawName === "AskUserQuestion") return "Question";

  // Codex toolset (snake_case)
  if (rawName === "update_plan") return "Planning";
  if (rawName === "shell_command" || rawName === "shell") return "Shell";
  if (rawName === "read_file") return "Read";
  if (rawName === "list_dir") return "LS";
  if (rawName === "grep_files") return "Grep";
  if (rawName === "apply_patch") return "Patch";

  // Codex toolset (PascalCase)
  if (rawName === "UpdatePlan") return "Planning";
  if (rawName === "ShellCommand" || rawName === "Shell") return "Shell";
  if (rawName === "ReadFile") return "Read";
  if (rawName === "ListDir") return "LS";
  if (rawName === "GrepFiles") return "Grep";
  if (rawName === "ApplyPatch") return "Patch";

  // Gemini toolset (snake_case)
  if (rawName === "run_shell_command") return "Shell";
  if (rawName === "list_directory") return "LS";
  if (rawName === "search_file_content") return "Grep";
  if (rawName === "write_todos") return "TODO";
  if (rawName === "read_many_files") return "Read Multiple";

  // Gemini toolset (PascalCase)
  if (rawName === "RunShellCommand") return "Shell";
  if (rawName === "ListDirectory") return "LS";
  if (rawName === "SearchFileContent") return "Grep";
  if (rawName === "WriteTodos") return "TODO";
  if (rawName === "ReadManyFiles") return "Read Multiple";

  // Additional tools
  if (rawName === "Replace" || rawName === "replace") return "Edit";
  if (rawName === "WriteFile" || rawName === "write_file") return "Write";
  if (rawName === "KillBash") return "Kill Shell";
  if (rawName === "BashOutput") return "Shell Output";
  if (rawName === "MultiEdit") return "Edit";

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
