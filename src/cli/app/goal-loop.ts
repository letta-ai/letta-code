import { buildGoalContinuationPrompt } from "@/cli/helpers/goal-command";
import type { GoalLoopState } from "@/goal-loop-mode";
import { settingsManager } from "@/settings-manager";

export function buildGoalPrompt(
  state: GoalLoopState,
  conversationId?: string | null,
): string {
  const storedGoal = conversationId
    ? settingsManager.getConversationGoal(conversationId)
    : null;
  const liveActiveSeconds =
    storedGoal?.activeStartedAt && storedGoal.status === "active"
      ? Math.max(
          0,
          Math.floor(
            (Date.now() - Date.parse(storedGoal.activeStartedAt)) / 1000,
          ),
        )
      : 0;
  return buildGoalContinuationPrompt({
    objective: state.originalPrompt,
    status: "active",
    tokensUsed: storedGoal?.tokensUsed ?? 0,
    tokenBudget: storedGoal?.tokenBudget ?? state.tokenBudget,
    timeUsedSeconds: (storedGoal?.activeTimeSeconds ?? 0) + liveActiveSeconds,
  });
}
