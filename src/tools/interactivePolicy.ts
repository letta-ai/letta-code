// Interactive tool capability policy shared across UI/headless/SDK-compatible paths.
// This avoids scattering name-based checks throughout approval handling.

export type YoloPlanModeApprovalPolicy =
  | "manual"
  | "enter_only"
  | "enter_and_exit";

const INTERACTIVE_APPROVAL_TOOLS = new Set([
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
]);

const RUNTIME_USER_INPUT_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);

function envFlagEnabled(name: string): boolean {
  const value = process.env[name];
  if (!value) return false;
  return value === "1" || value.toLowerCase() === "true";
}

function readYoloPlanModeApprovalPolicyFromEnv(): YoloPlanModeApprovalPolicy | null {
  const value = process.env.LETTA_YOLO_PLAN_MODE_APPROVAL?.trim().toLowerCase();
  if (!value) return null;
  if (value === "manual") return "manual";
  if (value === "enter_only") return "enter_only";
  if (value === "enter_and_exit") return "enter_and_exit";
  return null;
}

export function getYoloPlanModeApprovalPolicy(): YoloPlanModeApprovalPolicy {
  return readYoloPlanModeApprovalPolicyFromEnv() ?? "manual";
}

export function shouldAutoApproveEnterPlanMode(): boolean {
  const policy = readYoloPlanModeApprovalPolicyFromEnv();
  if (policy) {
    return policy === "enter_only" || policy === "enter_and_exit";
  }
  return (
    envFlagEnabled("LETTA_AUTO_APPROVE_PLAN_MODE") ||
    envFlagEnabled("LETTA_AUTO_APPROVE_ENTER_PLAN_MODE")
  );
}

export function shouldAutoApproveExitPlanMode(): boolean {
  const policy = readYoloPlanModeApprovalPolicyFromEnv();
  if (policy) return policy === "enter_and_exit";
  return (
    envFlagEnabled("LETTA_AUTO_APPROVE_PLAN_MODE") ||
    envFlagEnabled("LETTA_AUTO_APPROVE_EXIT_PLAN_MODE")
  );
}

export function isInteractiveApprovalTool(toolName: string): boolean {
  return INTERACTIVE_APPROVAL_TOOLS.has(toolName);
}

export function requiresRuntimeUserInput(toolName: string): boolean {
  return RUNTIME_USER_INPUT_TOOLS.has(toolName);
}

export function isHeadlessAutoAllowTool(toolName: string): boolean {
  if (toolName === "EnterPlanMode") return shouldAutoApproveEnterPlanMode();
  if (toolName === "ExitPlanMode") return shouldAutoApproveExitPlanMode();
  return false;
}
