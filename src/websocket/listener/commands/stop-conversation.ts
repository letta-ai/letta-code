import { getBackend } from "@/backend";
import { ApiRequestError } from "@/backend/api/request";
import { runWithRuntimeContext } from "@/runtime-context";
import { stopConversationBackground } from "@/tools/impl/stop-conversation-background";
import { cancelConversationWakes } from "@/tools/impl/wake";
import type { ConversationRuntimeScope } from "@/types/runtime-scope";
import type {
  SubagentStopCommand,
  SubagentStopResponse,
} from "@/types/subagent-protocol";
import { getErrorMessage } from "@/utils/error";

/** The control socket is scoped to the same conversation as this stop. */
export async function stopListenerConversation(
  command: SubagentStopCommand,
  abort: (scope: ConversationRuntimeScope) => Promise<boolean>,
  deps: { cancelWakes?: typeof cancelConversationWakes } = {},
): Promise<SubagentStopResponse> {
  const base: SubagentStopResponse = {
    type: "subagent_stop_response",
    request_id: command.request_id,
    runtime: command.runtime,
    agent_id: command.agent_id,
    success: false,
    stopped: false,
  };
  const scope = command.conversation;
  if (
    !scope ||
    scope.conversation_id !== command.runtime.conversation_id ||
    (scope.agent_id && scope.agent_id !== command.runtime.agent_id)
  )
    return {
      ...base,
      error: "Stop conversation does not match the control scope",
    };
  const backgroundScope = {
    agentId: scope.agent_id ?? command.runtime.agent_id,
    conversationId: scope.conversation_id,
  };
  try {
    // Stop notification producers before cancellation lets the active turn unwind.
    const results = await Promise.allSettled([
      stopConversationBackground(backgroundScope),
      abort(scope),
    ]);
    for (const result of results)
      if (result.status === "rejected") throw result.reason;
    const aborted = results[1]?.status === "fulfilled" && results[1].value;
    if (!aborted) {
      try {
        const results = await getBackend().cancelConversation(
          scope.conversation_id,
        );
        if (Object.values(results).some((value) => value !== "cancelled"))
          throw new Error("Backend did not confirm cancellation of every run");
      } catch (error) {
        // An idle child may still own monitors and schedules.
        if (!(error instanceof ApiRequestError && error.status === 409))
          throw error;
      }
    }
    await stopConversationBackground(backgroundScope);
    await runWithRuntimeContext(
      { ...backgroundScope, actingUserId: command.runtime.acting_user_id },
      () => (deps.cancelWakes ?? cancelConversationWakes)(backgroundScope),
    );
    return { ...base, success: true, stopped: true, cleanup_confirmed: true };
  } catch (error) {
    return { ...base, error: getErrorMessage(error) };
  }
}
