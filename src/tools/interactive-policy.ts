// Interactive tool capability policy shared across UI/headless/SDK-compatible paths.
// This avoids scattering name-based checks throughout approval handling.

const INTERACTIVE_APPROVAL_TOOLS = new Set(["AskUserQuestion"]);

export type InteractiveApprovalKind = "ask_user_question";

const RUNTIME_USER_INPUT_TOOLS = new Set(["AskUserQuestion"]);

/**
 * Tools that prompt the human for input mid-turn, as toolset names. Headless
 * clients (SDK sessions, automation) can exclude these from the turn's
 * toolset via `exclude_interactive_tools` on create_message payloads.
 */
export const INTERACTIVE_USER_INPUT_TOOL_NAMES: readonly string[] = [
  ...RUNTIME_USER_INPUT_TOOLS,
];

const HEADLESS_AUTO_ALLOW_TOOLS = new Set<string>();

export function isInteractiveApprovalTool(toolName: string): boolean {
  return INTERACTIVE_APPROVAL_TOOLS.has(toolName);
}

export function getInteractiveApprovalKind(
  toolName: string,
): InteractiveApprovalKind | null {
  switch (toolName) {
    case "AskUserQuestion":
      return "ask_user_question";
    default:
      return null;
  }
}

export function requiresRuntimeUserInput(toolName: string): boolean {
  return RUNTIME_USER_INPUT_TOOLS.has(toolName);
}

export function isHeadlessAutoAllowTool(toolName: string): boolean {
  return HEADLESS_AUTO_ALLOW_TOOLS.has(toolName);
}
