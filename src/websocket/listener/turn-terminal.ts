import type { Buffers } from "@/cli/helpers/accumulator";
import type { UsageStatistics } from "@/types/protocol";
import type { StopReasonType } from "@/types/protocol_v2";
import { debugWarn } from "@/utils/debug";
import { TO_SUBSCRIBERS } from "./connection";
import {
  completePreparedInputTerminal,
  prepareInputTerminal,
} from "./input-terminal-journal";
import {
  forgetListenerWork,
  readInterruptedTurn,
} from "./interrupted-turn-record";
import {
  emitInterruptedStatusDelta,
  emitRuntimeStateUpdates,
} from "./protocol-outbound";
import { emitLoopErrorNotice } from "./recoverable-notices";
import type { ListenerTransport } from "./transport";
import {
  type createTurnFinishedStore,
  emitDurableTurnFinished,
  getTurnFinishedOwner,
  prepareTurnFinished,
  type ReplayableTurnFinished,
} from "./turn-finished-replay";
import type { TurnFinishTransition, TurnLease } from "./turn-lifecycle";
import type { ConversationRuntime, InputIdentity } from "./types";

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
    errorNotice?: Omit<
      Parameters<typeof emitLoopErrorNotice>[2],
      "stopReason" | "isTerminal"
    >;
    usage?: UsageStatistics;
    terminalConsumerIds?: readonly string[];
    durableInputIdentities?: readonly InputIdentity[];
    /** Recovery claims fence terminal persistence and transport emission. */
    canCommit?: () => boolean;
    /** Deterministic persistence seams for listener durability tests. */
    forgetWork?: () => void;
    turnFinishedStore?: ReturnType<typeof createTurnFinishedStore>;
    prepareInputTerminal?: typeof prepareInputTerminal;
    completePreparedInputTerminal?: typeof completePreparedInputTerminal;
  },
): TurnFinishTransition {
  const rejectedCommit = (): TurnFinishTransition => ({
    finished: false,
    previousKind: null,
    runId: null,
    interruptionCause: null,
  });
  if (!runtime.turnLifecycle.isCurrent(lease)) {
    return runtime.turnLifecycle.finish(lease, options.stopReason);
  }
  if (options.canCommit && !options.canCommit()) {
    return rejectedCommit();
  }
  const turnFinishedMessage: ReplayableTurnFinished | null =
    options.socket && options.turnId
      ? {
          type: "turn_finished",
          turn_id: options.turnId,
          stop_reason: options.stopReason,
          ...(options.terminalConsumerIds?.length
            ? {
                terminal_consumer_ids: [
                  ...new Set(options.terminalConsumerIds),
                ],
              }
            : {}),
          ...((options.runId ?? runtime.activeRunId)
            ? { run_id: options.runId ?? runtime.activeRunId ?? undefined }
            : {}),
          ...(options.error ? { error: options.error } : {}),
          ...(options.usage ? { usage: options.usage } : {}),
        }
      : null;
  const interruptedRevision = readInterruptedTurn(runtime)?.revision;
  const terminalOwner = getTurnFinishedOwner(runtime, interruptedRevision);
  let preparedTurnFinished: ReturnType<typeof prepareTurnFinished> | null =
    null;
  if (
    turnFinishedMessage &&
    !(options.prepareInputTerminal ?? prepareInputTerminal)(
      runtime,
      options.durableInputIdentities ?? [],
      {
        scope: {
          agentId: runtime.agentId,
          conversationId: runtime.conversationId,
        },
        message: turnFinishedMessage,
        owner: terminalOwner,
      },
    )
  ) {
    // No state transition is safe: the accepted input is still replayable.
    runtime.turnLifecycle.finish(lease, options.stopReason);
    throw new Error("Failed to atomically prepare accepted-input terminal");
  }
  // The input journal fsync above can cross a claim's local expiry. Leave the
  // prepared journal for the successor rather than persisting as a stale owner.
  if (options.canCommit && !options.canCommit()) {
    return rejectedCommit();
  }
  const deferUntilReplayOwner =
    runtime.listener.connectionId?.startsWith("conn-") === true &&
    !!turnFinishedMessage?.terminal_consumer_ids?.length &&
    terminalOwner.connectionId === null &&
    !options.turnFinishedStore;
  try {
    preparedTurnFinished =
      turnFinishedMessage && !deferUntilReplayOwner
        ? prepareTurnFinished(
            runtime,
            turnFinishedMessage,
            options.turnFinishedStore,
            terminalOwner,
          )
        : null;
    if (
      turnFinishedMessage &&
      !deferUntilReplayOwner &&
      !(options.completePreparedInputTerminal ?? completePreparedInputTerminal)(
        runtime,
        options.durableInputIdentities ?? [],
        turnFinishedMessage.turn_id,
      )
    ) {
      throw new Error("Failed to promote accepted-input terminal");
    }
  } catch (error) {
    // Persistence failure is visible to the owner, but it must not strand the
    // active lease forever (notably when the bounded store reaches capacity).
    runtime.turnLifecycle.finish(lease, options.stopReason);
    throw error;
  }
  // Terminal-store locking and fsync can also cross expiry. At this point the
  // terminal has a durable home, so a successor can replay it without rerunning
  // the input; only the stale owner's lifecycle transition is fenced.
  const mayEmit = !options.canCommit || options.canCommit();
  if (!mayEmit) {
    return rejectedCommit();
  }
  const transition = runtime.turnLifecycle.finish(lease, options.stopReason);
  if (!transition.finished) {
    return transition;
  }
  // Publish the terminal failure before idle can complete the accepted send.
  // The lifecycle transition above prevents stale or duplicate finalizers
  // from emitting either the failure or its following status snapshots.
  if (mayEmit && options.socket && options.errorNotice) {
    const runId =
      options.errorNotice.runId ?? options.runId ?? transition.runId;
    const message = emitLoopErrorNotice(options.socket, runtime, {
      ...options.errorNotice,
      stopReason: options.stopReason,
      isTerminal: true,
      runId,
      agentId: options.agentId,
      conversationId: options.conversationId,
    });
    runtime.lastTerminalLoopErrorMessage =
      message ?? options.errorNotice.message;
    runtime.lastTerminalLoopErrorRunId = runId ?? null;
  }

  // Explicit abort projects the interrupted state when it moves the lease to
  // cancelling. Only server-originated cancellation reaches finish from active.
  if (
    options.stopReason === "cancelled" &&
    transition.previousKind === "active" &&
    options.socket &&
    mayEmit
  ) {
    emitInterruptedStatusDelta(options.socket, runtime, {
      runId: options.runId ?? transition.runId,
      agentId: options.agentId,
      conversationId: options.conversationId,
    });
  }

  if (mayEmit && transition.previousKind === "active") {
    emitRuntimeStateUpdates(runtime, {
      agent_id: options.agentId ?? null,
      conversation_id: options.conversationId,
    });
  }
  if (
    mayEmit &&
    options.socket &&
    turnFinishedMessage &&
    preparedTurnFinished
  ) {
    emitDurableTurnFinished(
      options.socket,
      runtime,
      turnFinishedMessage,
      TO_SUBSCRIBERS,
      options.turnFinishedStore,
      preparedTurnFinished,
    );
  }
  // Once the terminal is either queued or durably represented, successful and
  // explicit-user terminal paths can destructively retire execution evidence.
  // Transport interruption retains it for continuation recovery.
  if (
    options.stopReason === "end_turn" ||
    (options.stopReason === "cancelled" &&
      transition.interruptionCause !== "transport")
  ) {
    try {
      (options.forgetWork ?? (() => forgetListenerWork(runtime)))();
    } catch (error) {
      // The terminal transition already owns cleanup. A failed unlink is
      // recoverable evidence, not a reason to wedge or reject a detached turn.
      debugWarn("recovery", "Failed to retire completed listener work", error);
    }
  }
  return transition;
}
