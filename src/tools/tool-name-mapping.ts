// Leaf module: must not statically import tools/manager. client-preferences
// imports these helpers and is reachable from tool-definitions
// (impl/wake -> cron -> websocket/listener/queue), so importing manager from
// here would reintroduce a runtime cycle that leaves TOOL_DEFINITIONS in its
// temporal dead zone when tool-definitions loads first.
import type { ToolName } from "./tool-definitions";

// Maps internal implementation names to the names shown to the model.
const TOOL_NAME_MAPPINGS: Partial<Record<ToolName, string>> = {
  // Align subagent-spawning tool with Claude Code: surface internal `Task` as `Agent`.
  // Internal implementation name stays `Task` for backward compat with existing
  // agent states; getInternalToolName("Agent") resolves back to "Task".
  Task: "Agent",
  AskUserQuestionAsync: "AskUserQuestion",
};

/** Get the server-facing name for a tool (maps internal names to what the model sees). */
export function getServerToolName(internalName: string): string {
  return TOOL_NAME_MAPPINGS[internalName as ToolName] || internalName;
}

/** Get the internal tool name from a server-facing name (tool calls/approvals arrive with server names). */
export function getInternalToolName(serverName: string): string {
  for (const [internal, server] of Object.entries(TOOL_NAME_MAPPINGS)) {
    if (server === serverName) {
      return internal;
    }
  }
  // If not in mapping, the server name is the internal name
  return serverName;
}
