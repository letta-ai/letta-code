import { generatePlanFilePath } from "../../cli/helpers/planName";
import { permissionMode } from "../../permissions/mode";

interface EnterPlanModeArgs {
  [key: string]: never;
}

interface EnterPlanModeResult {
  message: string;
}

export async function enter_plan_mode(
  _args: EnterPlanModeArgs,
): Promise<EnterPlanModeResult> {
  // Normally this is handled by handleEnterPlanModeApprove in the UI layer,
  // which sets up state and returns a precomputed result (so this function
  // never runs). But if the generic approval flow is used for any reason,
  // we need to set up state here as a defensive fallback.
  if (
    permissionMode.getMode() !== "plan" ||
    !permissionMode.getPlanFilePath()
  ) {
    const planFilePath = generatePlanFilePath();
    permissionMode.setMode("plan");
    permissionMode.setPlanFilePath(planFilePath);
  }

  const planFilePath = permissionMode.getPlanFilePath();

  return {
    message: `Entered plan mode. You should now focus on exploring the codebase and designing an implementation approach.

In plan mode, you should:
1. Thoroughly explore the codebase to understand existing patterns
2. Identify similar features and architectural approaches
3. Consider multiple approaches and their trade-offs
4. Use AskUserQuestion if you need to clarify the approach
5. Design a concrete implementation strategy
6. When ready, use ExitPlanMode to present your plan for approval

Remember: DO NOT write or edit any files yet. This is a read-only exploration and planning phase.

Plan file path: ${planFilePath}`,
  };
}
