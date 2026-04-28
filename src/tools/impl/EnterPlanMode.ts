import { relative } from "node:path";
import { generatePlanFilePath } from "../../cli/helpers/planName";
import { permissionMode } from "../../permissions/mode";
import { getCurrentWorkingDirectory } from "../../runtime-context";
import { getExecutionContextPermissionModeState } from "../manager";

interface EnterPlanModeArgs {
  /** Injected by executeTool — do not pass manually */
  _executionContextId?: string;
}

interface EnterPlanModeResult {
  message: string;
}

export async function enter_plan_mode(
  args: EnterPlanModeArgs,
): Promise<EnterPlanModeResult> {
  // Resolve the permission mode state: prefer the per-conversation scoped
  // state when an execution context is present (listener/remote mode);
  // fall back to a wrapper around the global singleton for local/CLI mode.
  const scopedState = args._executionContextId
    ? getExecutionContextPermissionModeState(args._executionContextId)
    : undefined;

  // Normally this is handled by handleEnterPlanModeApprove in the UI layer,
  // which sets up state and returns a precomputed result (so this function
  // never runs). But if the generic approval flow is used for any reason,
  // we need to set up state here as a defensive fallback.
  if (scopedState) {
    if (scopedState.mode !== "plan" || !scopedState.planFilePath) {
      const planFilePath = generatePlanFilePath();
      scopedState.modeBeforePlan =
        scopedState.modeBeforePlan ?? scopedState.mode;
      scopedState.mode = "plan";
      scopedState.planFilePath = planFilePath;
    }
  } else {
    if (
      permissionMode.getMode() !== "plan" ||
      !permissionMode.getPlanFilePath()
    ) {
      const planFilePath = generatePlanFilePath();
      permissionMode.setMode("plan");
      permissionMode.setPlanFilePath(planFilePath);
    }
  }

  const planFilePath =
    scopedState?.planFilePath ?? permissionMode.getPlanFilePath();
  const cwd = getCurrentWorkingDirectory();
  const applyPatchRelativePath = planFilePath
    ? relative(cwd, planFilePath).replace(/\\/g, "/")
    : null;

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

Plan file path: ${planFilePath}
${applyPatchRelativePath ? `If using apply_patch, use this exact relative patch path: ${applyPatchRelativePath}` : ""}`,
  };
}
