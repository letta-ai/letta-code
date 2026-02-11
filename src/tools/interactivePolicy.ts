// Interactive tool capability policy shared across UI/headless/SDK-compatible paths.
// This avoids scattering name-based checks throughout approval handling.

const INTERACTIVE_APPROVAL_TOOLS = new Set([
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
]);

const RUNTIME_USER_INPUT_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);

const HEADLESS_AUTO_ALLOW_TOOLS = new Set(["EnterPlanMode"]);

export function isInteractiveApprovalTool(toolName: string): boolean {
  return INTERACTIVE_APPROVAL_TOOLS.has(toolName);
}

export function requiresRuntimeUserInput(toolName: string): boolean {
  return RUNTIME_USER_INPUT_TOOLS.has(toolName);
}

export function isHeadlessAutoAllowTool(toolName: string): boolean {
  return HEADLESS_AUTO_ALLOW_TOOLS.has(toolName);
}
