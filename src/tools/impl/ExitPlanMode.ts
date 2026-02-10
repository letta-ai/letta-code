/**
 * ExitPlanMode tool implementation
 * Exits plan mode - the plan is read from the plan file by the UI
 */

import { permissionMode } from "../../permissions/mode";

export async function exit_plan_mode(): Promise<{ message: string }> {
  // In interactive mode, the UI restores mode before calling this tool.
  // In headless/bidirectional mode, there is no UI layer to do that, so
  // restore here as a fallback to avoid getting stuck in plan mode.
  if (permissionMode.getMode() === "plan") {
    const restoredMode = permissionMode.getModeBeforePlan() ?? "default";
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
