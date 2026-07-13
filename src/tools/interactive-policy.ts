// Interactive tool capability policy shared across UI/headless/SDK-compatible paths.
// This avoids scattering name-based checks throughout approval handling.

type ToolArgs = Record<string, unknown> | null | undefined;

const ASK_USER_QUESTION_TOOL = "AskUserQuestion";
const MESSAGE_CHANNEL_TOOL = "MessageChannel";
const MESSAGE_CHANNEL_ASK_ACTION = "ask";

const INTERACTIVE_APPROVAL_TOOLS = new Set([ASK_USER_QUESTION_TOOL]);

export type InteractiveApprovalKind = "ask_user_question";

const RUNTIME_USER_INPUT_TOOLS = new Set([ASK_USER_QUESTION_TOOL]);

const HEADLESS_AUTO_ALLOW_TOOLS = new Set<string>();

function isMessageChannelAsk(toolName: string, args?: ToolArgs): boolean {
  return (
    toolName === MESSAGE_CHANNEL_TOOL &&
    typeof args?.action === "string" &&
    args.action.trim().toLowerCase() === MESSAGE_CHANNEL_ASK_ACTION
  );
}

export function isInteractiveApprovalTool(
  toolName: string,
  args?: ToolArgs,
): boolean {
  return (
    INTERACTIVE_APPROVAL_TOOLS.has(toolName) ||
    isMessageChannelAsk(toolName, args)
  );
}

export function getInteractiveApprovalKind(
  toolName: string,
  args?: ToolArgs,
): InteractiveApprovalKind | null {
  if (
    toolName === ASK_USER_QUESTION_TOOL ||
    isMessageChannelAsk(toolName, args)
  ) {
    return "ask_user_question";
  }
  return null;
}

export function requiresRuntimeUserInput(
  toolName: string,
  args?: ToolArgs,
): boolean {
  return (
    RUNTIME_USER_INPUT_TOOLS.has(toolName) ||
    isMessageChannelAsk(toolName, args)
  );
}

export function isHeadlessAutoAllowTool(toolName: string): boolean {
  return HEADLESS_AUTO_ALLOW_TOOLS.has(toolName);
}
