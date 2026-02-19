const SHELL_TOOL_NAMES = new Set([
  "Bash",
  "shell",
  "Shell",
  "shell_command",
  "ShellCommand",
  "run_shell_command",
  "RunShellCommand",
]);

const READ_TOOL_NAMES = new Set([
  "Read",
  "read_file",
  "ReadFile",
  "read_file_gemini",
  "ReadFileGemini",
]);

const WRITE_TOOL_NAMES = new Set([
  "Write",
  "write_file",
  "WriteFile",
  "write_file_gemini",
  "WriteFileGemini",
]);

const EDIT_TOOL_NAMES = new Set([
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "replace",
  "Replace",
]);

const GLOB_TOOL_NAMES = new Set(["Glob", "glob_gemini", "GlobGemini"]);

const GREP_TOOL_NAMES = new Set([
  "Grep",
  "grep_files",
  "GrepFiles",
  "search_file_content",
  "SearchFileContent",
]);

const LIST_TOOL_NAMES = new Set([
  "list_dir",
  "ListDir",
  "list_directory",
  "ListDirectory",
  "LS",
]);

const TASK_TOOL_NAMES = new Set(["Task", "task"]);

const FILE_TOOL_FAMILIES = new Set([
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "ListDir",
]);

export function canonicalToolName(toolName: string): string {
  if (SHELL_TOOL_NAMES.has(toolName)) return "Bash";
  if (READ_TOOL_NAMES.has(toolName)) return "Read";
  if (WRITE_TOOL_NAMES.has(toolName)) return "Write";
  if (EDIT_TOOL_NAMES.has(toolName)) return "Edit";
  if (GLOB_TOOL_NAMES.has(toolName)) return "Glob";
  if (GREP_TOOL_NAMES.has(toolName)) return "Grep";
  if (LIST_TOOL_NAMES.has(toolName)) return "ListDir";
  if (TASK_TOOL_NAMES.has(toolName)) return "Task";
  return toolName;
}

export function isShellToolName(toolName: string): boolean {
  return canonicalToolName(toolName) === "Bash";
}

export function isFileToolName(toolName: string): boolean {
  return FILE_TOOL_FAMILIES.has(canonicalToolName(toolName));
}

export function canonicalizePathLike(value: string): string {
  let normalized = value.replace(/\\/g, "/").trim();

  if (/^\/+[a-zA-Z]:\//.test(normalized)) {
    normalized = normalized.replace(/^\/+/, "");
  }

  if (/^[a-zA-Z]:\//.test(normalized)) {
    normalized = `${normalized[0]?.toUpperCase() ?? ""}${normalized.slice(1)}`;
  }

  return normalized;
}
