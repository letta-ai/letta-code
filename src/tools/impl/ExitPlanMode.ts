/**
 * ExitPlanMode tool implementation
 * Exits plan mode - the plan is read from the plan file by the UI
 */

export async function exit_plan_mode(): Promise<{ message: string }> {
  // Return confirmation message that plan was approved
  // Note: The plan is read from the plan file by the UI before this return is shown
  // The UI layer checks if the plan file exists and auto-rejects if not
  return {
    message:
      "User has approved your plan. You can now start coding.\nStart with updating your todo list if applicable",
  };
}
