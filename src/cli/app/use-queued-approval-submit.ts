// src/cli/app/useQueuedApprovalSubmit.ts

import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type { ApprovalCreate } from "@letta-ai/letta-client/resources/agents/messages";
import { type Dispatch, type MutableRefObject, useCallback } from "react";
import type { ApprovalResult } from "@/agent/approval-execution";
import {
  buildFreshDenialApprovals,
  STALE_APPROVAL_RECOVERY_DENIAL_REASON,
} from "@/agent/approval-recovery";
import { getResumeDataFromBackend } from "@/agent/check-approval";
import { getBackend } from "@/backend";
import type { Buffers } from "@/cli/helpers/accumulator";
import { prepareBuffersForTurn } from "@/cli/helpers/transcript-eviction";
import { debugWarn } from "@/utils/debug";

import { createClientOtid } from "./ids";
import type {
  ProcessConversation,
  ProcessConversationOptions,
  QueueApprovalResults,
  QueuedApprovalMetadata,
} from "./types";

type QueuedApprovalSubmitContext = {
  agentId: string;
  buffersRef: MutableRefObject<Buffers>;
  conversationGenerationRef: MutableRefObject<number>;
  conversationIdRef: MutableRefObject<string>;
  emittedIdsRef: MutableRefObject<Set<string>>;
  interruptQueuedRef: MutableRefObject<boolean>;
  /**
   * The turn signals of isAgentBusy() without commandRunning, which the
   * calling command sets itself. Read at call time, so it must only read refs.
   */
  isTurnInFlight: () => boolean;
  needsEagerApprovalCheck: boolean;
  processConversation: ProcessConversation;
  queueApprovalResults: QueueApprovalResults;
  queuedApprovalMetadataRef: MutableRefObject<QueuedApprovalMetadata | null>;
  queuedApprovalResultsRef: MutableRefObject<ApprovalResult[] | null>;
  setNeedsEagerApprovalCheck: Dispatch<boolean>;
};

/**
 * New-turn entry used by command/skill/mod paths. Evicts committed transcript
 * lines before the turn starts so those sessions stay bounded the same way as
 * typed Enter. Mid-turn reentry must call `processConversation` directly —
 * eviction here would shift `order` after `transcriptStartLineIndex` is
 * captured. For the same reason nothing is evicted while a turn is in flight
 * (busy-safe commands such as /mods can get here mid-stream) or when queued
 * approval results continue an interrupted turn: processConversation keeps
 * that turn's saved transcript start index.
 */
export async function processNewTurnWithQueuedApprovals(args: {
  buffers: Buffers;
  committedIds: ReadonlySet<string>;
  consumeQueuedApprovalInput: () => ApprovalCreate | null;
  input: Array<MessageCreate | ApprovalCreate>;
  isTurnInFlight: () => boolean;
  options?: ProcessConversationOptions;
  processConversation: ProcessConversation;
}): Promise<void> {
  const queuedApprovalInput = args.consumeQueuedApprovalInput();
  const evict = !queuedApprovalInput && !args.isTurnInFlight();
  if (evict) prepareBuffersForTurn(args.buffers, args.committedIds);
  const nextInput = queuedApprovalInput
    ? [queuedApprovalInput, ...args.input]
    : args.input;
  await args.processConversation(
    nextInput,
    evict
      ? {
          ...args.options,
          // Eviction shifted `order`; a prior turn's slice index is no longer valid.
          transcriptStartLineIndex:
            args.options?.transcriptStartLineIndex ?? null,
        }
      : args.options,
  );
}

export function useQueuedApprovalSubmit(ctx: QueuedApprovalSubmitContext) {
  const {
    agentId,
    buffersRef,
    conversationGenerationRef,
    conversationIdRef,
    emittedIdsRef,
    interruptQueuedRef,
    isTurnInFlight,
    needsEagerApprovalCheck,
    processConversation,
    queueApprovalResults,
    queuedApprovalMetadataRef,
    queuedApprovalResultsRef,
    setNeedsEagerApprovalCheck,
  } = ctx;

  /**
   * Check and handle any pending approvals before sending a slash command.
   * Returns true if approvals need user input (caller should return { submitted: false }).
   * Returns false if no approvals or all auto-handled (caller can proceed).
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: queued approval refs are stable objects; .current is read dynamically during the check.
  const checkPendingApprovalsForSlashCommand = useCallback(async (): Promise<
    { blocked: true } | { blocked: false }
  > => {
    // Only check eagerly when resuming a session (LET-7101)
    if (!needsEagerApprovalCheck) {
      return { blocked: false };
    }

    const queuedMetadata = queuedApprovalMetadataRef.current;
    const hasQueuedRealResults =
      queuedApprovalResultsRef.current !== null &&
      queuedApprovalResultsRef.current.length > 0 &&
      queuedMetadata?.conversationId === conversationIdRef.current &&
      queuedMetadata.generation === conversationGenerationRef.current;
    if (hasQueuedRealResults) {
      setNeedsEagerApprovalCheck(false);
      return { blocked: false };
    }

    try {
      const agent = await getBackend().retrieveAgent(agentId);
      const { pendingApprovals: existingApprovals } =
        await getResumeDataFromBackend(agent, conversationIdRef.current);

      if (!existingApprovals || existingApprovals.length === 0) {
        setNeedsEagerApprovalCheck(false);
        return { blocked: false };
      }

      const staleDenials = buildFreshDenialApprovals(
        existingApprovals,
        STALE_APPROVAL_RECOVERY_DENIAL_REASON,
      ) as ApprovalResult[];
      if (staleDenials.length > 0) {
        queueApprovalResults(staleDenials, {
          conversationId: conversationIdRef.current,
          generation: conversationGenerationRef.current,
        });
        setNeedsEagerApprovalCheck(false);
      }

      return { blocked: false };
    } catch {
      // If check fails, proceed anyway (don't block user)
      return { blocked: false };
    }
  }, [
    agentId,
    needsEagerApprovalCheck,
    queueApprovalResults,
    setNeedsEagerApprovalCheck,
  ]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: queued approval refs are stable objects; .current is read dynamically when consumed.
  const consumeQueuedApprovalInputForCurrentConversation = useCallback(
    (otid: string = createClientOtid()): ApprovalCreate | null => {
      const queuedResults = queuedApprovalResultsRef.current;
      if (!queuedResults || queuedResults.length === 0) {
        return null;
      }

      const queuedMetadata = queuedApprovalMetadataRef.current;
      const isQueuedValid =
        queuedMetadata &&
        queuedMetadata.conversationId === conversationIdRef.current &&
        queuedMetadata.generation === conversationGenerationRef.current;

      queueApprovalResults(null);
      interruptQueuedRef.current = false;

      if (!isQueuedValid) {
        debugWarn(
          "queue",
          "Dropping stale queued approval results for mismatched conversation or generation",
        );
        return null;
      }

      return {
        type: "approval",
        approvals: queuedResults,
        otid,
      };
    },
    [queueApprovalResults, interruptQueuedRef],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: buffer/emitted-id refs are stable objects; .current is read at call time. isTurnInFlight only reads refs.
  const processConversationWithQueuedApprovals = useCallback(
    async (
      input: Array<MessageCreate | ApprovalCreate>,
      options?: Parameters<typeof processConversation>[1],
    ): Promise<void> => {
      await processNewTurnWithQueuedApprovals({
        buffers: buffersRef.current,
        committedIds: emittedIdsRef.current,
        consumeQueuedApprovalInput:
          consumeQueuedApprovalInputForCurrentConversation,
        input,
        isTurnInFlight,
        options,
        processConversation,
      });
    },
    [consumeQueuedApprovalInputForCurrentConversation, processConversation],
  );

  return {
    checkPendingApprovalsForSlashCommand,
    consumeQueuedApprovalInputForCurrentConversation,
    processConversationWithQueuedApprovals,
  };
}
