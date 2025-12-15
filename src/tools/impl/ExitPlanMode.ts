/**
 * ExitPlanMode tool implementation
 * Exits plan mode - the plan is read from the plan file by the UI
 */

import { existsSync } from "node:fs";
import { permissionMode } from "../../permissions/mode";

export async function exit_plan_mode(): Promise<{ message: string }> {
  // Check if plan file exists - force agent to actually write a plan
  const planFilePath = permissionMode.getPlanFilePath();
  if (!planFilePath || !existsSync(planFilePath)) {
    return {
      message:
        "Error: You must write your plan to the plan file before exiting plan mode.\n" +
        `Plan file path: ${planFilePath || "not set"}\n` +
        "Use the Write tool to create your plan, then call ExitPlanMode again.",
    };
  }

  // Return confirmation message that plan was approved
  // Note: The plan is read from the plan file by the UI before this return is shown
  return {
    message:
      "User has approved your plan. You can now start coding.\nStart with updating your todo list if applicable",
  };
}
