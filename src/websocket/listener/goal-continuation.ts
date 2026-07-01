// Autonomous goal-loop re-entry for the websocket listener (Desktop/API
// surface). The TUI re-enters the goal loop at end_turn via
// use-conversation-loop.ts; the listener historically injected a single
// continuation prompt and stopped. This module mirrors the TUI stop/continue
// logic so a /goal keeps taking autonomous turns on the listener too.
//
// The step cap is the single source of truth shared with the TUI: every goal is
// activated with a max-step limit (GOAL_DEFAULT_MAX_STEPS = 50 by default, set
// via `/goal --max-steps N`, or disabled with `--max-steps 0`), stored on
// goalLoopMode and enforced here via goalLoopMode.hasReachedStepLimit().

import { buildGoalContinuationPrompt } from "@/cli/helpers/goal-command";
import { goalLoopMode } from "@/goal-loop-mode";
import { settingsManager } from "@/settings-manager";
import {
  getOrCreateConversationPermissionModeStateRef,
  persistPermissionModeMapForRuntime,
} from "./permission-mode";
import type { ConversationRuntime, IncomingMessage } from "./types";

export type GoalContinuationAction =
  | "stop_inactive"
  | "stop_unclean"
  | "stop_status"
  | "stop_cap"
  | "stop_budget"
  | "continue";

/**
 * Pure decision: given the loop/turn/goal state after a turn completes, decide
 * whether the listener should take another autonomous goal turn.
 *
 * Continuation only happens after a clean `end_turn`. A cancelled or errored
 * turn (`lastStopReason !== "end_turn"`) stops the loop, as does the goal being
 * marked complete/blocked/paused (status !== "active"), reaching the shared
 * step cap (`reachedStepLimit`), or exhausting the token budget.
 */
export function decideGoalContinuation(input: {
  goalActive: boolean;
  lastStopReason: string | null;
  goalStatus: string | null;
  reachedStepLimit: boolean;
  tokensUsed: number;
  tokenBudget: number | null;
}): GoalContinuationAction {
  if (!input.goalActive) return "stop_inactive";
  if (input.lastStopReason !== "end_turn") return "stop_unclean";
  if (input.goalStatus !== "active") return "stop_status";
  if (input.reachedStepLimit) return "stop_cap";
  if (input.tokenBudget !== null && input.tokensUsed >= input.tokenBudget) {
    return "stop_budget";
  }
  return "continue";
}

/**
 * End the autonomous goal loop: deactivate the in-process loop mode and restore
 * the standard permission mode for the conversation (the loop runs in
 * unrestricted mode). Safe to call when the loop is already inactive.
 */
function stopGoalLoop(
  runtime: ConversationRuntime,
  agentId: string | undefined,
  conversationId: string,
): void {
  if (goalLoopMode.getState().isActive) {
    goalLoopMode.deactivate();
  }
  if (!agentId) return;
  const permState = getOrCreateConversationPermissionModeStateRef(
    runtime.listener,
    agentId,
    conversationId,
  );
  if (permState.mode === "unrestricted") {
    permState.mode = "standard";
    persistPermissionModeMapForRuntime(runtime.listener);
  }
}

/**
 * After a turn completes, decide whether to continue the active goal and, if
 * so, build the next continuation turn. Applies the required side effects
 * (iteration bump, or loop teardown + permission restore) and returns the next
 * message to feed back through the turn pipeline, or `null` to stop.
 */
export function buildGoalContinuationTurn(
  previousMessage: IncomingMessage,
  runtime: ConversationRuntime,
): IncomingMessage | null {
  const agentId = previousMessage.agentId;
  const conversationId = previousMessage.conversationId ?? "default";
  const goalState = goalLoopMode.getState();
  const storedGoal = settingsManager.getConversationGoal(conversationId);

  const action = decideGoalContinuation({
    goalActive: goalState.isActive,
    lastStopReason: runtime.lastStopReason,
    goalStatus: storedGoal?.status ?? null,
    reachedStepLimit: goalLoopMode.hasReachedStepLimit(),
    tokensUsed: storedGoal?.tokensUsed ?? 0,
    tokenBudget: storedGoal?.tokenBudget ?? goalState.tokenBudget,
  });

  if (action === "stop_inactive") {
    // Not a goal turn (or already torn down) — nothing to do.
    return null;
  }

  if (action !== "continue") {
    stopGoalLoop(runtime, agentId, conversationId);
    return null;
  }

  goalLoopMode.incrementIteration();
  const nextState = goalLoopMode.getState();
  const liveActiveSeconds =
    storedGoal?.activeStartedAt && storedGoal.status === "active"
      ? Math.max(
          0,
          Math.floor(
            (Date.now() - Date.parse(storedGoal.activeStartedAt)) / 1000,
          ),
        )
      : 0;
  const text = buildGoalContinuationPrompt({
    objective: nextState.originalPrompt,
    status: "active",
    tokensUsed: storedGoal?.tokensUsed ?? 0,
    tokenBudget: storedGoal?.tokenBudget ?? nextState.tokenBudget,
    timeUsedSeconds: (storedGoal?.activeTimeSeconds ?? 0) + liveActiveSeconds,
    currentStep: nextState.currentIteration,
    maxSteps: nextState.maxSteps,
  });

  return {
    type: "message",
    agentId,
    conversationId,
    messages: [
      {
        type: "message",
        role: "user",
        content: [{ type: "text", text }],
      },
    ],
    ...(previousMessage.actingUserId
      ? { actingUserId: previousMessage.actingUserId }
      : {}),
  };
}
