// Retired memory tools; kept so saved transcripts still render them.
const MEMORY_TOOL_NAMES = new Set(["memory", "memory_apply_patch"]);

export function getDisplayToolName(rawName: string): string {
  if (MEMORY_TOOL_NAMES.has(rawName)) return "Memory";

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

  if (rawName === "exec_command" || rawName === "write_stdin") return "Bash";
  if (rawName === "shell_command" || rawName === "shell") return "Bash";
  if (rawName === "read_file") return "Read";
  if (rawName === "list_dir") return "LS";
  if (rawName === "grep_files") return "Search";
  if (rawName === "web_search") return "Web Search";
  if (rawName === "fetch_webpage") return "Fetch Webpage";

  if (rawName === "UpdatePlan") return "Planning";
  if (rawName === "ShellCommand" || rawName === "Shell") return "Bash";
  if (rawName === "ReadFile") return "Read";
  if (rawName === "ListDir") return "LS";
  if (rawName === "GrepFiles") return "Search";
  if (rawName === "ApplyPatch") return "Patch";
  if (rawName === "WebSearch") return "Web Search";
  if (rawName === "FetchWebpage") return "Fetch Webpage";

  if (rawName === "KillBash") return "Kill Bash";
  // Retired output pollers; kept so saved transcripts still render them.
  if (rawName === "BashOutput") return "Shell Output";
  if (rawName === "TaskOutput") return "Task Output";
  if (rawName === "MultiEdit") return "Update";

  return rawName;
}

export function isTaskTool(name: string): boolean {
  return (
    name === "Task" || name === "task" || name === "Agent" || name === "agent"
  );
}

export function isWorkflowTool(name: string): boolean {
  return name === "Workflow" || name === "workflow";
}

export function isTodoTool(rawName: string, displayName?: string): boolean {
  return (
    rawName === "todo_write" ||
    rawName === "TodoWrite" ||
    displayName === "TODO"
  );
}

export function isTaskCrudTool(rawName: string): boolean {
  return (
    rawName === "TaskCreate" ||
    rawName === "TaskGet" ||
    rawName === "TaskList" ||
    rawName === "TaskUpdate"
  );
}

export function isPlanTool(rawName: string, displayName?: string): boolean {
  return rawName === "UpdatePlan" || displayName === "Planning";
}

export function isFancyUITool(name: string): boolean {
  return (
    name === "AskUserQuestion" ||
    isFileEditTool(name) ||
    isFileWriteTool(name) ||
    isPatchTool(name) ||
    isShellTool(name)
  );
}

export function isMemoryTool(name: string): boolean {
  return MEMORY_TOOL_NAMES.has(name);
}

export function isFileEditTool(name: string): boolean {
  return (
    name === "edit" ||
    name === "Edit" ||
    name === "multi_edit" ||
    name === "MultiEdit"
  );
}

export function isFileWriteTool(name: string): boolean {
  return name === "write" || name === "Write";
}

export function isFileReadTool(name: string): boolean {
  return (
    name === "read" ||
    name === "Read" ||
    name === "ViewImage" ||
    name === "ReadFile" ||
    name === "read_file"
  );
}

export function isPatchTool(name: string): boolean {
  return name === "ApplyPatch";
}

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
 * Includes shell command tools plus the retired TaskOutput/BashOutput pollers,
 * which saved transcripts still contain.
 */
export function isShellOutputTool(name: string): boolean {
  const n = name.toLowerCase();
  return isShellTool(name) || n === "taskoutput" || n === "bashoutput";
}

export function isSearchTool(name: string): boolean {
  return (
    name === "grep" ||
    name === "Grep" ||
    name === "grep_files" ||
    name === "GrepFiles"
  );
}

export function isWebSearchTool(name: string | undefined): boolean {
  return name === "web_search" || name === "WebSearch" || name === "webSearch";
}

export function isGlobTool(name: string): boolean {
  return name === "glob" || name === "Glob";
}
