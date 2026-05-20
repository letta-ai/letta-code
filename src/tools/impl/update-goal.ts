import { getConversationId } from "@/agent/context";
import { getCurrentWorkingDirectory } from "@/runtime-context";
import { settingsManager } from "@/settings-manager";

export async function update_goal(
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (args.status !== "complete") {
    throw new Error(
      'update_goal can only mark the existing goal complete; use status "complete".',
    );
  }
  const conversationId = getConversationId();
  if (!conversationId) {
    throw new Error("No active conversation.");
  }
  const workingDirectory = getCurrentWorkingDirectory();
  const goal = settingsManager.updateConversationGoalStatus(
    conversationId,
    "complete",
    workingDirectory,
  );
  if (!goal) {
    throw new Error("No active goal exists for this conversation.");
  }
  return {
    goal,
    remaining_tokens:
      goal.tokenBudget != null
        ? Math.max(0, goal.tokenBudget - goal.tokensUsed)
        : null,
    completion_budget_report: goal.tokenBudget
      ? `Goal achieved. Report final budget usage to the user: tokens used: ${goal.tokensUsed} of ${goal.tokenBudget}; time used: ${goal.activeTimeSeconds} seconds.`
      : null,
  };
}
