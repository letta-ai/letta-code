const REMOVED_TOOL_NAMES = new Set([
  "BashOutput",
  "GrepFiles",
  "grep_files",
  "KillBash",
  "ListDir",
  "list_dir",
  "memory",
  "memory_apply_patch",
  "MultiEdit",
  "multi_edit",
  "ReadFile",
  "read_file",
  "Shell",
  "shell",
  "ShellCommand",
  "shell_command",
  "TaskOutput",
  "TodoWrite",
]);

export function getRemovedToolNames(): string[] {
  return [...REMOVED_TOOL_NAMES];
}

export function isRemovedToolName(toolName: string): boolean {
  return REMOVED_TOOL_NAMES.has(toolName);
}

export function findRemovedToolNames(toolNames: readonly string[]): string[] {
  return toolNames.filter(isRemovedToolName);
}
