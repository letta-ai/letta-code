/**
 * ExitPlanMode tool implementation
 * Exits plan mode by presenting the plan to the user for approval
 */

import { validateRequiredParams } from "./validation.js";

interface ExitPlanModeArgs {
  plan: string;
}

export async function exit_plan_mode(
  args: ExitPlanModeArgs,
): Promise<{ message: string }> {
  validateRequiredParams(args, ["plan"], "ExitPlanMode");
  const { plan: _plan } = args;

  // Return confirmation message that plan was approved
  // Note: The plan itself should be displayed by the UI/system before this return is shown
  return {
    message:
      "User has approved your plan. You can now start coding.\nStart with updating your todo list if applicable",
  };
}
