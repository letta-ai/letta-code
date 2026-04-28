// Interactive tool capability policy shared across UI/headless/SDK-compatible paths.
// This avoids scattering name-based checks throughout approval handling.

const INTERACTIVE_APPROVAL_TOOLS = new Set([
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
]);

export type InteractiveApprovalKind =
  | "ask_user_question"
  | "enter_plan_mode"
  | "exit_plan_mode";

const RUNTIME_USER_INPUT_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);

const HEADLESS_AUTO_ALLOW_TOOLS = new Set(["EnterPlanMode", "ExitPlanMode"]);

export function isInteractiveApprovalTool(toolName: string): boolean {
  return INTERACTIVE_APPROVAL_TOOLS.has(toolName);
}

export function getInteractiveApprovalKind(
  toolName: string,
): InteractiveApprovalKind | null {
  switch (toolName) {
    case "AskUserQuestion":
      return "ask_user_question";
    case "EnterPlanMode":
      return "enter_plan_mode";
    case "ExitPlanMode":
      return "exit_plan_mode";
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
