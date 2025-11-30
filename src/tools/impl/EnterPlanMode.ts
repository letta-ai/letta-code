interface EnterPlanModeArgs {
  [key: string]: never;
}

interface EnterPlanModeResult {
  message: string;
}

export async function enter_plan_mode(
  _args: EnterPlanModeArgs,
): Promise<EnterPlanModeResult> {
  // This is handled by the UI layer which will:
  // 1. Show approval dialog
  // 2. On approve: toggle plan mode on, generate plan file path, inject system reminder
  // 3. On reject: send rejection, agent proceeds without plan mode
  //
  // The message below is returned on successful entry into plan mode.
  // The UI harness will also inject a <system-reminder> with the plan file path.
  return {
    message: `Entered plan mode. You should now focus on exploring the codebase and designing an implementation approach.

In plan mode, you should:
1. Thoroughly explore the codebase to understand existing patterns
2. Identify similar features and architectural approaches
3. Consider multiple approaches and their trade-offs
4. Use AskUserQuestion if you need to clarify the approach
5. Design a concrete implementation strategy
6. When ready, use ExitPlanMode to present your plan for approval

Remember: DO NOT write or edit any files yet. This is a read-only exploration and planning phase.`,
  };
}
