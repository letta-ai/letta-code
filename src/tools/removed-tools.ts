// Bundled tools that no longer exist. An allowlist skips unknown names without
// comment because it also carries MCP and external tool names, so naming one of
// these is the only case where a dropped entry is worth a warning.
const REMOVED_TOOL_NAMES = new Set([
  "BashOutput",
  "GrepFiles",
  "grep_files",
  "KillBash",
  "ListDir",
  "list_dir",
  "LS",
  "MultiEdit",
  "ReadFile",
  "read_file",
  "Shell",
  "shell",
  "ShellCommand",
  "shell_command",
  "TodoWrite",
]);

export function isRemovedToolName(toolName: string): boolean {
  return REMOVED_TOOL_NAMES.has(toolName);
}

export function findRemovedToolNames(toolNames: readonly string[]): string[] {
  return toolNames.filter(isRemovedToolName);
}
