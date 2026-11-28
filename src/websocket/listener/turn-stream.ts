import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import { getStreamRequestContext } from "@/agent/message";
import { normalizeStreamErrorTypeToStopReason } from "@/agent/turn-recovery-policy";
import type { createBuffers } from "@/cli/helpers/accumulator";
import { drainStreamWithResume } from "@/cli/helpers/stream";
import type { StreamDelta } from "@/types/protocol_v2";
import { isCloudApiDeploymentInterrupted } from "@/utils/cloud-api-shutdown";
import { debugLog } from "@/utils/debug";
import { normalizeCloudRetryWireMessage } from "./cloud-retry-message";
import { LISTENER_STREAM_RESUME_POLICY } from "./constants";
import {
  recordListenerWork,
  recordListenerWorkRetriably,
} from "./interrupted-turn-record";
import { normalizeToolReturnWireMessage } from "./interrupts";
import {
  emitCanonicalMessageDelta,
  emitLoopStatusUpdate,
} from "./protocol-outbound";
import { emitLoopErrorNotice } from "./recoverable-notices";
import { getApprovalToolCallDesyncErrorText } from "./recovery";
import type { RecoveryEvidenceWriter } from "./recovery-evidence";
import type { ListenerTransport } from "./transport";
import type { TurnCorrelation } from "./turn-correlation";
import type { TurnLease } from "./turn-lifecycle";
import type { ConversationRuntime, InputIdentity } from "./types";

export type TurnStreamDrainParams = {
  agentId: string | null;
  conversationId: string;
  turnLease: TurnLease;
  turnCorrelation: TurnCorrelation;
  msgRunIds: string[];
  runId: string | undefined;
  durableInputIdentities?: readonly InputIdentity[];
  terminalConsumerIds?: readonly string[];
  authorityGuard?: () => boolean;
  interruptedRevisionRef?: { current: string | undefined };
  recoveryLineageId?: string;
  recoveryEvidenceWriter?: RecoveryEvidenceWriter;
};

export type TurnStreamDrainResult = {
  result: Awaited<ReturnType<typeof drainStreamWithResume>>;
  runId: string | undefined;
};

export async function drainTurnStreamWithEmission(
  stream: Stream<LettaStreamingResponse>,
  buffers: ReturnType<typeof createBuffers>,
  socket: ListenerTransport,
  runtime: ConversationRuntime,
  params: TurnStreamDrainParams,
): Promise<TurnStreamDrainResult> {
  const { agentId, conversationId, turnLease, turnCorrelation, msgRunIds } =
    params;
  const turnAbortSignal = turnLease.signal;
  let runIdSent = false;
  let runId = params.runId;

  const result = await drainStreamWithResume(
    stream,
    buffers,
    () => {},
    turnAbortSignal,
    undefined,
    async ({ chunk, shouldOutput, errorInfo }) => {
      const ownsTurn = () =>
        !turnAbortSignal.aborted && runtime.turnLifecycle.isCurrent(turnLease);
      if (!ownsTurn()) return { shouldOutput: false, shouldAccumulate: false };
      const maybeRunId = (chunk as { run_id?: unknown }).run_id;
      const hasAuthority = () => params.authorityGuard?.() !== false;
      if (typeof maybeRunId === "string") {
        runId = maybeRunId;
        runtime.turnLifecycle.setRunId(turnLease, maybeRunId);
        turnCorrelation.observeRun(maybeRunId);
        if (!runIdSent) {
          const update = {
            runId: maybeRunId,
            actingUserId: getStreamRequestContext(stream)?.actingUserId,
            durableInputIdentities: params.durableInputIdentities
              ? [...params.durableInputIdentities]
              : undefined,
            terminalConsumerIds: params.terminalConsumerIds
              ? [...params.terminalConsumerIds]
              : undefined,
          };
          const expectedRevision = params.interruptedRevisionRef?.current;
          if (params.recoveryEvidenceWriter) {
            const revision = await params.recoveryEvidenceWriter(
              runtime,
              update,
              "run_observed",
              expectedRevision,
              params.recoveryLineageId,
            );
            if (typeof revision === "string" && params.interruptedRevisionRef) {
              params.interruptedRevisionRef.current = revision;
            }
          } else {
            try {
              const revision = recordListenerWork(
                runtime,
                update,
                "run_observed",
                expectedRevision,
                params.recoveryLineageId,
              );
              if (revision && params.interruptedRevisionRef) {
                params.interruptedRevisionRef.current = revision;
              }
            } catch (error) {
              if (
                !(error instanceof Error) ||
                (error.message !==
                  "Timed out acquiring durable filesystem lock" &&
                  error.message !== "Interrupted-turn revision changed" &&
                  error.message !== "Recovery lineage revision changed" &&
                  error.message !==
                    "Interrupted-turn revision cannot recreate a record")
              ) {
                throw error;
              }
              const revision = await recordListenerWorkRetriably(
                runtime,
                update,
                "run_observed",
                expectedRevision,
                params.recoveryLineageId,
                {
                  shouldContinue: () => ownsTurn() && hasAuthority(),
                },
              );
              if (revision && params.interruptedRevisionRef) {
                params.interruptedRevisionRef.current = revision;
              }
            }
          }
          if (!ownsTurn())
            return { shouldOutput: false, shouldAccumulate: false };
          runIdSent = true;
          msgRunIds.push(maybeRunId);
          if (hasAuthority()) {
            emitLoopStatusUpdate(socket, runtime, {
              agent_id: agentId,
              conversation_id: conversationId,
            });
          }
        }
      }
      if (errorInfo) {
        const recoverableApprovalErrorText =
          getApprovalToolCallDesyncErrorText(errorInfo);
        const deploymentInterrupted =
          isCloudApiDeploymentInterrupted(errorInfo);
        if (
          hasAuthority() &&
          !recoverableApprovalErrorText &&
          !deploymentInterrupted
        ) {
          emitLoopErrorNotice(socket, runtime, {
            message: errorInfo.message || "Stream error",
            stopReason: normalizeStreamErrorTypeToStopReason(
              errorInfo.error_type,
            ),
            isTerminal: false,
            runId: runId || errorInfo.run_id,
            agentId,
            conversationId,
            errorInfo,
            cancelRequested: turnAbortSignal.aborted,
            abortSignal: turnAbortSignal,
          });
        } else {
          debugLog(
            "recovery",
            "Suppressing streamed recoverable error while post-stop recovery runs: %s",
            recoverableApprovalErrorText ?? errorInfo.error_code,
          );
        }
        if (deploymentInterrupted) {
          return { shouldOutput: false, shouldAccumulate: false };
        }
      }
      if (shouldOutput && hasAuthority()) {
        const normalizedChunk =
          normalizeCloudRetryWireMessage(chunk) ??
          normalizeToolReturnWireMessage(
            chunk as unknown as Record<string, unknown>,
          );
        if (normalizedChunk) {
          emitCanonicalMessageDelta(
            socket,
            runtime,
            {
              ...normalizedChunk,
              type: "message",
            } as StreamDelta,
            {
              agent_id: agentId,
              conversation_id: conversationId,
            },
          );
        }
      }

      return undefined;
    },
    runtime.contextTracker,
    undefined,
    LISTENER_STREAM_RESUME_POLICY,
  );

  return { result, runId };
}
