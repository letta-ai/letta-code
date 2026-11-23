import type { ToolName } from "./tool-definitions";

const TOOL_NAME_MAPPINGS: Partial<Record<ToolName, string>> = {
  Task: "Agent",
  AskUserQuestionAsync: "AskUserQuestion",
};

export function getServerToolName(internalName: string): string {
  return TOOL_NAME_MAPPINGS[internalName as ToolName] || internalName;
}

export function getInternalToolName(serverName: string): string {
  for (const [internal, server] of Object.entries(TOOL_NAME_MAPPINGS)) {
    if (server === serverName) {
      return internal;
    }
  }
  return serverName;
}
