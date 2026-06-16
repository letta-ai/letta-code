import type { ContextTracker } from "@/cli/helpers/context-tracker";
import {
  type ReflectionSettings,
  type ReflectionTrigger,
  shouldFireStepCountTrigger,
} from "@/cli/helpers/memory-reminder";
import { getReflectionTranscriptState } from "@/cli/helpers/reflection-transcript";
import {
  type SharedReminderState,
  syncReminderStateFromContextTracker,
} from "@/reminders/state";

export type PostTurnReflectionLauncher = (
  triggerSource: Exclude<ReflectionTrigger, "off">,
) => Promise<boolean>;

/**
 * Evaluate reflection triggers at turn end and launch the reflection subagent
 * if one fires. Call after the turn's transcript delta has been appended so
 * step counts include the just-finished turn.
 */
export async function maybeLaunchPostTurnReflection(params: {
  agentId?: string | null;
  conversationId: string;
  memfsEnabled: boolean;
  reflectionSettings: ReflectionSettings;
  reminderState: SharedReminderState;
  contextTracker: ContextTracker;
  launch: PostTurnReflectionLauncher;
  getTranscriptState?: typeof getReflectionTranscriptState;
}): Promise<boolean> {
  if (!params.agentId || !params.memfsEnabled) {
    return false;
  }

  switch (params.reflectionSettings.trigger) {
    case "off":
      return false;
    case "compaction-event": {
      syncReminderStateFromContextTracker(
        params.reminderState,
        params.contextTracker,
      );
      if (!params.reminderState.pendingReflectionTrigger) {
        return false;
      }
      params.reminderState.pendingReflectionTrigger = false;
      return params.launch("compaction-event");
    }
    case "step-count": {
      const readTranscriptState =
        params.getTranscriptState ?? getReflectionTranscriptState;
      const transcriptState = await readTranscriptState(
        params.agentId,
        params.conversationId,
      );
      if (
        !shouldFireStepCountTrigger(
          transcriptState.steps_since_last_successful_reflection,
          params.reflectionSettings,
        )
      ) {
        return false;
      }
      return params.launch("step-count");
    }
  }
}
