import { getConversationId } from "../../agent/context";
import { getCurrentWorkingDirectory } from "../../runtime-context";
import { settingsManager } from "../../settings-manager";

export async function get_goal(): Promise<Record<string, unknown>> {
  const conversationId = getConversationId();
  if (!conversationId) {
    return { goal: null, remaining_tokens: null };
  }
  const goal = settingsManager.getConversationGoal(
    conversationId,
    getCurrentWorkingDirectory(),
  );
  return {
    goal,
    remaining_tokens:
      goal?.tokenBudget != null
        ? Math.max(0, goal.tokenBudget - goal.tokensUsed)
        : null,
  };
}
