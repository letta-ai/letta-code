import { getAgentRuntimeStatus } from "@/backend/api/agents";
import { debugWarn } from "@/utils/debug";
import {
  isInboundTeleportExpected,
  isRuntimeTeleportPending,
} from "./teleport";
import type { ConversationRuntime } from "./types";

function hasRecoveryHandoff(runtime: ConversationRuntime): boolean {
  return (
    isInboundTeleportExpected(runtime) ||
    isRuntimeTeleportPending(
      runtime.listener,
      runtime.agentId,
      runtime.conversationId,
    )
  );
}

/** Recovery observes pending work; it must not take it from another listener. */
export async function canRecoverConversation(
  runtime: ConversationRuntime,
  readStatus = getAgentRuntimeStatus,
): Promise<boolean> {
  if (hasRecoveryHandoff(runtime)) return false;
  // Cloud relay registration assigns conn-* IDs. Embedded App Servers have
  // only local connection IDs, with no server-side ownership record.
  // Do not infer this from the API hostname: CI runs Cloud on a local URL.
  const connectionId = runtime.listener.connectionId;
  if (!connectionId?.startsWith("conn-")) {
    return true;
  }
  if (!runtime.agentId) return true;
  try {
    const snapshot = await readStatus(
      runtime.agentId,
      [runtime.conversationId],
      AbortSignal.timeout(5_000),
    );
    if (
      hasRecoveryHandoff(runtime) ||
      runtime.listener.connectionId !== connectionId
    )
      return false;
    const status = snapshot.statuses.find(
      (entry) => entry.conversation_id === runtime.conversationId,
    );
    if (!status || status.has_conflicting_listeners) return false;
    if (status.active_harness)
      return status.active_harness.connection_id === connectionId;
    // A delivery or unclaimed live run is not an ownerless crashed turn.
    return status.state === "IDLE";
  } catch (error) {
    debugWarn(
      "recovery",
      "Could not verify conversation recovery ownership",
      error,
    );
    return false;
  }
}
