/**
 * UpdatePlan tool implementation
 *
 * This is a no-op tool that exists purely to give the model a structured way
 * to communicate its plan to the client for rendering. The tool call arguments
 * are what matter, not the execution.
 *
 * Matches the Codex update_plan tool behavior.
 */

export async function update_plan(
  _args: Record<string, unknown>,
): Promise<{ message: string }> {
  // This is a no-op - the UI will render the plan from the tool call arguments
  // Just return success without validation to match Codex behavior
  return {
    message: "Plan updated",
  };
}
