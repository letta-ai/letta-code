import type { Buffers } from "@/cli/helpers/accumulator";
import type { UsageStatistics } from "@/types/protocol";
import type { StopReasonType } from "@/types/protocol_v2";
import { debugWarn } from "@/utils/debug";
import { TO_SUBSCRIBERS } from "./connection";
import {
  claimPreparedInputTerminalIfCurrent,
  completePreparedInputTerminal,
  loadPreparedInputTerminals,
  prepareInputTerminal,
} from "./input-terminal-journal";
import { readInterruptedTurn } from "./interrupted-turn-read";
import {
  createInterruptedTurnStore,
  forgetListenerWork,
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
    /** Persist a crash proof even when no external terminal consumer exists. */
    persistTerminalWithoutConsumers?: boolean;
    /** Exact interrupted revision owned by this finalizer. */
    expectedInterruptedRevision?: string;
    /** Recovery lineages read their sidecar revision view, not successor main. */
    readInterruptedRevision?: () => string | undefined;
    /** Mutable checkpoint generation that owns this terminal transition. */
    expectedInterruptedAuthorityRevision?: string;
    readInterruptedAuthorityRevision?: () => string | undefined;
    /** Independent recovery lineage bound to the mutable authority token. */
    recoveryLineageId?: string;
    recoveryAuthorityGuard?: Pick<
      ReturnType<typeof createInterruptedTurnStore>,
      "withRecoveryAuthority"
    >;
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
  const readRevision =
    options.readInterruptedRevision ??
    (() => readInterruptedTurn(runtime)?.revision);
  const interruptedRevision = readRevision();
  const expectedAuthorityRevision =
    options.expectedInterruptedAuthorityRevision ??
    options.expectedInterruptedRevision;
  const readAuthorityRevision =
    options.readInterruptedAuthorityRevision ?? readRevision;
  if (
    expectedAuthorityRevision !== undefined &&
    readAuthorityRevision() !== expectedAuthorityRevision
  ) {
    return rejectedCommit();
  }
  const ownsInterruptedRevision = () => {
    if (options.canCommit && !options.canCommit()) return false;
    return (
      expectedAuthorityRevision === undefined ||
      readAuthorityRevision() === expectedAuthorityRevision
    );
  };
  const terminalOwner = getTurnFinishedOwner(runtime, interruptedRevision);
  if (
    interruptedRevision &&
    expectedAuthorityRevision &&
    options.recoveryLineageId
  ) {
    terminalOwner.recoveryLineageId = options.recoveryLineageId;
    terminalOwner.interruptedAuthorityRevision = expectedAuthorityRevision;
  }
  const identitylessConsumerTerminal =
    !!turnFinishedMessage?.terminal_consumer_ids?.length &&
    (options.durableInputIdentities?.length ?? 0) === 0;
  if (identitylessConsumerTerminal && terminalOwner.connectionId === null) {
    // With no accepted-input identity there is no journal entry that can wait
    // for a future subscriber to become the replay owner. Persist a rotatable
    // process-owned terminal directly instead of retiring all evidence.
    terminalOwner.canRotate = true;
  }
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
        ...(options.persistTerminalWithoutConsumers
          ? { persistWithoutConsumers: true }
          : {}),
      },
    )
  ) {
    // No state transition is safe: the accepted input is still replayable.
    runtime.turnLifecycle.finish(lease, options.stopReason);
    throw new Error("Failed to atomically prepare accepted-input terminal");
  }
  // The input journal fsync above can cross a claim's local expiry. Leave the
  // prepared journal for the successor rather than persisting as a stale owner.
  if (!ownsInterruptedRevision()) {
    return rejectedCommit();
  }
  const deferUntilReplayOwner =
    runtime.listener.connectionId?.startsWith("conn-") === true &&
    !!turnFinishedMessage?.terminal_consumer_ids?.length &&
    terminalOwner.connectionId === null &&
    !identitylessConsumerTerminal &&
    !options.turnFinishedStore;
  const authorityGuard =
    options.recoveryAuthorityGuard ??
    (!options.readInterruptedRevision &&
    !options.readInterruptedAuthorityRevision
      ? createInterruptedTurnStore()
      : undefined);
  let guardDirectPublication = false;
  try {
    if (
      !options.prepareInputTerminal &&
      !deferUntilReplayOwner &&
      (turnFinishedMessage?.terminal_consumer_ids?.length ||
        options.persistTerminalWithoutConsumers)
    ) {
      const preparedInputTerminal = loadPreparedInputTerminals(
        runtime.listener,
      ).find(
        (prepared) =>
          prepared.scope.agentId === runtime.agentId &&
          prepared.scope.conversationId === runtime.conversationId &&
          prepared.owner.terminalIdentity === terminalOwner.terminalIdentity,
      );
      if (preparedInputTerminal) {
        if (
          !claimPreparedInputTerminalIfCurrent(
            runtime.listener,
            preparedInputTerminal,
            [],
            authorityGuard,
          )
        ) {
          throw new Error(
            "Failed to claim accepted-input terminal publication",
          );
        }
      } else if (
        options.recoveryLineageId &&
        expectedAuthorityRevision &&
        authorityGuard?.withRecoveryAuthority
      ) {
        guardDirectPublication = true;
      }
    }
  } catch (error) {
    runtime.turnLifecycle.finish(lease, options.stopReason);
    throw error;
  }
  try {
    const persistTerminal = () =>
      turnFinishedMessage && !deferUntilReplayOwner
        ? prepareTurnFinished(
            runtime,
            turnFinishedMessage,
            options.turnFinishedStore,
            terminalOwner,
            options.persistTerminalWithoutConsumers ||
              identitylessConsumerTerminal,
          )
        : null;
    if (
      guardDirectPublication &&
      authorityGuard?.withRecoveryAuthority &&
      options.recoveryLineageId &&
      expectedAuthorityRevision
    ) {
      const guarded = authorityGuard.withRecoveryAuthority({
        agentId: runtime.agentId ?? "",
        conversationId: runtime.conversationId,
        lineageId: options.recoveryLineageId,
        expectedRevision: expectedAuthorityRevision,
        action: () => {
          preparedTurnFinished = persistTerminal();
          return true;
        },
      });
      if (!guarded)
        throw new Error("Recovery authority changed before terminal");
    } else {
      preparedTurnFinished = persistTerminal();
    }
    if (!ownsInterruptedRevision()) return rejectedCommit();
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
  const mayEmit = ownsInterruptedRevision();
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
      (
        options.forgetWork ??
        (() => forgetListenerWork(runtime, interruptedRevision ?? null))
      )();
    } catch (error) {
      // The terminal transition already owns cleanup. A failed unlink is
      // recoverable evidence, not a reason to wedge or reject a detached turn.
      debugWarn("recovery", "Failed to retire completed listener work", error);
    }
  }
  return transition;
}
