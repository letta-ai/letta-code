import { getConversationId } from "@/agent/context";
import { getCurrentWorkingDirectory } from "@/runtime-context";
import { settingsManager } from "@/settings-manager";

export async function create_goal(
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const objective =
    typeof args.objective === "string" ? args.objective.trim() : "";
  if (!objective) {
    throw new Error("objective is required");
  }
  const tokenBudget =
    typeof args.token_budget === "number" && Number.isFinite(args.token_budget)
      ? Math.floor(args.token_budget)
      : null;
  if (tokenBudget !== null && tokenBudget <= 0) {
    throw new Error("token_budget must be a positive integer");
  }
  const conversationId = getConversationId();
  if (!conversationId) {
    throw new Error("No active conversation.");
  }
  const workingDirectory = getCurrentWorkingDirectory();
  const existing = settingsManager.getConversationGoal(
    conversationId,
    workingDirectory,
  );
  if (existing) {
    throw new Error(
      "cannot create a new goal because this conversation already has a goal; use update_goal only when the existing goal is complete",
    );
  }
  const goal = settingsManager.setConversationGoal(
    conversationId,
    objective,
    workingDirectory,
    tokenBudget,
    true,
  );
  return {
    goal,
    remaining_tokens: tokenBudget,
  };
}
