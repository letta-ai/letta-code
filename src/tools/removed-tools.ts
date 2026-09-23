// Bundled tools that no longer exist. An allowlist skips unknown names without
// comment because it also carries MCP and external tool names, so naming one of
// these is the only case where a dropped entry is worth a warning. The names
// also stay reserved for mods: saved permission rules and transcripts still
// read them as the old tools.
const REMOVED_TOOL_NAMES = new Set([
  "BashOutput",
  "GrepFiles",
  "grep_files",
  "KillBash",
  "ListDir",
  "list_dir",
  "LS",
  "MultiEdit",
  // Never registered under this name, but the approval and transcript
  // classifiers still treat it as MultiEdit, so it must stay reserved too.
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
