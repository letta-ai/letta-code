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
import { recordListenerWork } from "./interrupted-turn-record";
import { normalizeToolReturnWireMessage } from "./interrupts";
import {
  emitCanonicalMessageDelta,
  emitLoopStatusUpdate,
} from "./protocol-outbound";
import { emitLoopErrorNotice } from "./recoverable-notices";
import { getApprovalToolCallDesyncErrorText } from "./recovery";
import type { ListenerTransport } from "./transport";
import type { TurnCorrelation } from "./turn-correlation";
import type { TurnLease } from "./turn-lifecycle";
import type { ConversationRuntime } from "./types";

export type TurnStreamDrainParams = {
  agentId: string | null;
  conversationId: string;
  turnLease: TurnLease;
  turnCorrelation: TurnCorrelation;
  /** Run IDs observed so far in this turn; the first run_id of this stream is appended. */
  msgRunIds: string[];
  /** Last run ID observed by the turn before this stream started, if any. */
  runId: string | undefined;
};

export type TurnStreamDrainResult = {
  result: Awaited<ReturnType<typeof drainStreamWithResume>>;
  /** Last run ID observed on the stream, or the incoming value when none arrived. */
  runId: string | undefined;
};

/**
 * Drains one message-turn stream for the listener: records the run ID on the
 * lease, forwards chunks to listener clients, and reports non-terminal stream
 * errors. When the socket carrying the stream dies mid-run, the resume loop
 * inside drainStreamWithResume re-attaches to the run with
 * LISTENER_STREAM_RESUME_POLICY, so a cloud-api rolling restart does not end
 * the turn.
 */
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
    ({ chunk, shouldOutput, errorInfo }) => {
      if (turnAbortSignal.aborted) {
        return undefined;
      }
      const maybeRunId = (chunk as { run_id?: unknown }).run_id;
      if (typeof maybeRunId === "string") {
        runId = maybeRunId;
        runtime.turnLifecycle.setRunId(turnLease, maybeRunId);
        turnCorrelation.observeRun(maybeRunId);
        if (!runIdSent) {
          recordListenerWork(runtime, {
            runId: maybeRunId,
            actingUserId: getStreamRequestContext(stream)?.actingUserId,
          });
          runIdSent = true;
          msgRunIds.push(maybeRunId);
          emitLoopStatusUpdate(socket, runtime, {
            agent_id: agentId,
            conversation_id: conversationId,
          });
        }
      }
      if (errorInfo) {
        const recoverableApprovalErrorText =
          getApprovalToolCallDesyncErrorText(errorInfo);
        const deploymentInterrupted =
          isCloudApiDeploymentInterrupted(errorInfo);
        if (!recoverableApprovalErrorText && !deploymentInterrupted) {
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
      if (shouldOutput) {
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
