import type { ToolCallLocation, ToolKind } from "@agentclientprotocol/sdk";

const TOOL_KINDS: Record<string, ToolKind> = {
  Read: "read",
  NotebookRead: "read",
  Edit: "edit",
  MultiEdit: "edit",
  Write: "edit",
  NotebookEdit: "edit",
  Bash: "execute",
  BashOutput: "execute",
  KillShell: "execute",
  Grep: "search",
  Glob: "search",
  WebSearch: "search",
  WebFetch: "fetch",
  TodoWrite: "think",
  Task: "other",
  Agent: "other",
};

export function toolKind(toolName: string): ToolKind {
  return TOOL_KINDS[toolName] ?? "other";
}

/** Short human-readable title for a tool call, e.g. `Read src/index.ts`. */
export function toolTitle(
  toolName: string,
  toolInput: Record<string, unknown>,
): string {
  const detail =
    firstString(toolInput, [
      "file_path",
      "path",
      "notebook_path",
      "pattern",
      "url",
      "query",
      "description",
    ]) ?? firstString(toolInput, ["command"]);
  if (!detail) return toolName;
  const trimmed = detail.length > 80 ? `${detail.slice(0, 77)}...` : detail;
  return `${toolName}: ${trimmed}`;
}

/** File locations touched by a tool call, for editors that follow along. */
export function toolLocations(
  toolInput: Record<string, unknown>,
): ToolCallLocation[] {
  const path = firstString(toolInput, ["file_path", "notebook_path", "path"]);
  if (path?.startsWith("/")) {
    return [{ path }];
  }
  return [];
}

function firstString(
  input: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}
