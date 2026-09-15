import type { Buffers } from "@/cli/helpers/accumulator";
import type { UsageStatistics } from "@/types/protocol";
import type { StopReasonType } from "@/types/protocol_v2";
import { TO_SUBSCRIBERS } from "./connection";
import { forgetListenerWork } from "./interrupted-turn-record";
import {
  emitInterruptedStatusDelta,
  emitProtocolV2Message,
  emitRuntimeStateUpdates,
} from "./protocol-outbound";
import type { ListenerTransport } from "./transport";
import type { TurnFinishTransition, TurnLease } from "./turn-lifecycle";
import type { ConversationRuntime, UndeliveredTurnFinished } from "./types";

export function buildTurnUsage(usage: Buffers["usage"]): UsageStatistics {
  return {
    prompt_tokens: usage.promptTokens,
    completion_tokens: usage.completionTokens,
    total_tokens: usage.totalTokens,
    step_count: usage.stepCount,
    cached_input_tokens: usage.cachedInputTokens,
    cache_write_tokens: usage.cacheWriteTokens,
    reasoning_tokens: usage.reasoningTokens,
    ...(usage.contextTokens !== undefined
      ? { context_tokens: usage.contextTokens }
      : {}),
  };
}

export function finishListenerTurn(
  runtime: ConversationRuntime,
  lease: TurnLease,
  options: {
    stopReason: StopReasonType;
    socket?: ListenerTransport;
    runId?: string | null;
    agentId?: string | null;
    conversationId: string;
    turnId?: string;
    error?: string;
    usage?: UsageStatistics;
  },
): TurnFinishTransition {
  const transition = runtime.turnLifecycle.finish(lease, options.stopReason);
  if (!transition.finished) {
    return transition;
  }
  if (options.stopReason === "end_turn" || options.stopReason === "cancelled") {
    forgetListenerWork(runtime);
  }

  // Explicit abort projects the interrupted state when it moves the lease to
  // cancelling. Only server-originated cancellation reaches finish from active.
  if (
    options.stopReason === "cancelled" &&
    transition.previousKind === "active" &&
    options.socket
  ) {
    emitInterruptedStatusDelta(options.socket, runtime, {
      runId: options.runId ?? transition.runId,
      agentId: options.agentId,
      conversationId: options.conversationId,
    });
  }

  if (transition.previousKind === "active") {
    emitRuntimeStateUpdates(runtime, {
      agent_id: options.agentId ?? null,
      conversation_id: options.conversationId,
    });
  }
  if (options.socket && options.turnId) {
    const message: UndeliveredTurnFinished = {
      type: "turn_finished",
      turn_id: options.turnId,
      stop_reason: options.stopReason,
      ...((options.runId ?? transition.runId)
        ? { run_id: options.runId ?? transition.runId ?? undefined }
        : {}),
      ...(options.error ? { error: options.error } : {}),
      ...(options.usage ? { usage: options.usage } : {}),
    };
    const delivered = emitProtocolV2Message(
      options.socket,
      runtime,
      message,
      {
        agent_id: options.agentId,
        conversation_id: options.conversationId,
      },
      TO_SUBSCRIBERS,
    );
    // The websocket can close between the last stream delta and this frame.
    // Subscribers (cloud-api, Desktop, a parent waiting on a remote turn)
    // treat the missing frame as a turn that never ended, so keep it for the
    // next connection that syncs or reconnects (see turn-finished-replay.ts).
    runtime.undeliveredTurnFinished = delivered ? null : message;
  }
  return transition;
}
