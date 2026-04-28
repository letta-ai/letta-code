/**
 * ExitPlanMode tool implementation
 * Exits plan mode - the plan is read from the plan file by the UI
 */

import { permissionMode } from "../../permissions/mode";
import { getExecutionContextPermissionModeState } from "../manager";

interface ExitPlanModeArgs {
  /** Injected by executeTool — do not pass manually */
  _executionContextId?: string;
}

export async function exit_plan_mode(
  args: ExitPlanModeArgs = {},
): Promise<{ message: string }> {
  // Resolve the permission mode state: prefer the per-conversation scoped
  // state when an execution context is present (listener/remote mode);
  // fall back to a wrapper around the global singleton for local/CLI mode.
  const scopedState = args._executionContextId
    ? getExecutionContextPermissionModeState(args._executionContextId)
    : undefined;

  // In interactive mode, the UI restores mode before calling this tool.
  // In headless/bidirectional mode, there is no UI layer to do that, so
  // restore here as a fallback to avoid getting stuck in plan mode.
  if (scopedState) {
    if (scopedState.mode === "plan") {
      const prev = scopedState.modeBeforePlan;
      // Restore the previous mode, but never restore "memory" — fall back to
      // "default" so the user isn't stuck in a restricted mode after plan approval.
      scopedState.mode = prev === "memory" ? "default" : (prev ?? "default");
      scopedState.modeBeforePlan = null;
      scopedState.planFilePath = null;
    }
  } else if (permissionMode.getMode() === "plan") {
    const prev = permissionMode.getModeBeforePlan();
    const restoredMode = prev === "memory" ? "default" : (prev ?? "default");
    permissionMode.setMode(restoredMode);
  }

  // Return confirmation message that plan was approved
  // Note: The plan is read from the plan file by the UI before this return is shown
  // The UI layer checks if the plan file exists and auto-rejects if not
  return {
    message:
      "User has approved your plan. You can now start coding.\n" +
      "Start with updating your todo list if applicable.\n\n" +
      "Tip: If this plan will be referenced in the future by your future-self, " +
      "other agents, or humans, consider renaming the plan file to something easily " +
      "identifiable with a timestamp (e.g., `2026-01-auth-refactor.md`) rather than the random name.",
  };
}
