import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type {
  ApprovalCreate,
  LettaStreamingResponse,
} from "@letta-ai/letta-client/resources/agents/messages";
import type { sendMessageStream } from "@/agent/message";
import {
  getRetryDelayMs,
  isProviderStreamTimeoutDetail,
} from "@/agent/turn-recovery-policy";
import { getRetryStatusMessage } from "@/cli/helpers/error-formatter";
import type { StopReasonType } from "@/types/protocol_v2";
import {
  CLOUD_API_DEPLOYMENT_RECOVERY_MAX_ATTEMPTS,
  LLM_API_ERROR_MAX_RETRIES,
} from "./constants";
import { appendQueuedTurnToInput } from "./continuation-input";
import { emitDequeuedUserMessage } from "./protocol-outbound";
import { consumeQueuedTurn } from "./queue";
import { emitRecoverableRetryNotice } from "./recoverable-notices";
import {
  finalizeHandledRecoveryTurn,
  isRetriablePostStopError,
} from "./recovery";
import {
  type ApprovalContinuationSendResult,
  isApprovalOnlyInput,
  sendApprovalContinuationWithRetry,
  sendMessageStreamWithRetry,
} from "./send";
import { injectQueuedSkillContent } from "./skill-injection";
import type { ListenerTransport } from "./transport";
import type { TurnCorrelation } from "./turn-correlation";
import {
  createDeploymentRecoveryTurnInput,
  ensureTurnInputMessageOtids,
  refreshTurnInputOtidsForNewRequest,
  type TurnInputState,
  updateTurnInputMessagesPreservingOtids,
} from "./turn-input-state";
import type { TurnFinishTransition, TurnLease } from "./turn-lifecycle";
import { setTurnLoopStatus } from "./turn-status";
import type { finishListenerTurn } from "./turn-terminal";
import type { ConversationRuntime, IncomingMessage } from "./types";

type SendOptions = NonNullable<Parameters<typeof sendMessageStream>[2]>;

export async function startTurnInput(
  params: Omit<
    Parameters<typeof createTurnInputSender>[0],
    "buildSendOptions"
  > & {
    workingDirectory: string;
    permissionModeState: SendOptions["permissionModeState"];
    preparedToolContext: SendOptions["preparedToolContext"];
    overrideModel: SendOptions["overrideModel"];
    responseFormat?: SendOptions["responseFormat"];
    getActingUserId: () => SendOptions["actingUserId"];
    getInput: () => TurnInputState;
    getInterruptedToolCallIds: () => string[];
  },
) {
  const sendParams = {
    ...params,
    buildSendOptions: () => {
      const actingUserId = params.getActingUserId();
      return {
        ...(params.agentId ? { agentId: params.agentId } : {}),
        streamTokens: true,
        background: true,
        workingDirectory: params.workingDirectory,
        permissionModeState: params.permissionModeState,
        ...(params.runtime.skillSources !== undefined
          ? { skillSources: params.runtime.skillSources }
          : {}),
        preparedToolContext: params.preparedToolContext,
        ...(params.getInput().imageFailureModesByMessageOtid
          ? {
              imageFailureModesByMessageOtid:
                params.getInput().imageFailureModesByMessageOtid,
            }
          : {}),
        ...(params.overrideModel
          ? { overrideModel: params.overrideModel }
          : {}),
        ...(params.responseFormat
          ? { responseFormat: params.responseFormat }
          : {}),
        ...(actingUserId !== undefined ? { actingUserId } : {}),
        ...(params.getInterruptedToolCallIds().length > 0
          ? {
              approvalNormalization: {
                interruptedToolCallIds: params.getInterruptedToolCallIds(),
              },
            }
          : {}),
      };
    },
  };
  const sender = createTurnInputSender(sendParams);
  const input = params.getInput();
  const withSkills = injectQueuedSkillContent(input.messages, params);
  const result = await sender.send(withSkills);
  return {
    sender,
    buildSendOptions: sendParams.buildSendOptions,
    input: updateTurnInputMessagesPreservingOtids(input, withSkills),
    stream: sender.accept(result),
  };
}

function getProviderRetryLimit(errorDetail: string | null): number {
  return isProviderStreamTimeoutDetail(errorDetail)
    ? 1
    : LLM_API_ERROR_MAX_RETRIES;
}

async function prepareProviderRetryInput(params: {
  input: TurnInputState;
  errorDetail: string | null;
  attempt: number;
  socket: ListenerTransport;
  runtime: ConversationRuntime;
  turnLease: TurnLease;
  agentId: string | null;
  conversationId: string;
  runId: string | null;
}): Promise<TurnInputState> {
  const maxAttempts = getProviderRetryLimit(params.errorDetail);
  const delayMs = getRetryDelayMs({
    category: "transient_provider",
    attempt: params.attempt,
    detail: params.errorDetail,
  });
  emitRecoverableRetryNotice(params.socket, params.runtime, {
    kind: "transient_provider_retry",
    message:
      getRetryStatusMessage(params.errorDetail) ||
      `LLM API error encountered, retrying (attempt ${params.attempt}/${maxAttempts})...`,
    reason: "llm_api_error",
    attempt: params.attempt,
    maxAttempts,
    delayMs,
    runId: params.runId ?? undefined,
    agentId: params.agentId,
    conversationId: params.conversationId,
  });
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  if (params.turnLease.signal.aborted) {
    throw new Error("Cancelled by user");
  }
  return refreshTurnInputOtidsForNewRequest(params.input);
}

export async function sendPostStopRetry(
  params: Parameters<typeof prepareProviderRetryInput>[0] & {
    deploymentInterrupted: boolean;
    sender: ReturnType<typeof createTurnInputSender>;
    setInput: (input: TurnInputState) => void;
    finishIfInterrupted: (runId?: string | null) => boolean;
    turnCorrelation: TurnCorrelation;
    noCoalesce?: boolean;
    onConsumeQueuedTurn: (queuedTurn: IncomingMessage) => Promise<void>;
    onDequeued: (batchId: string, actingUserId: string | null) => void;
  },
): Promise<
  | { kind: "interrupted" }
  | {
      kind: "sent";
      result: ApprovalContinuationSendResult;
    }
> {
  const { agentId, conversationId, runtime, runId, socket, turnLease } = params;
  let input = params.deploymentInterrupted
    ? createDeploymentRecoveryTurnInput()
    : await prepareProviderRetryInput(params);
  if (params.finishIfInterrupted(runId)) return { kind: "interrupted" };

  const consumed =
    params.deploymentInterrupted || params.noCoalesce
      ? null
      : consumeQueuedTurn(runtime, { continuation: true });
  if (consumed) {
    const { dequeuedBatch, queuedTurn } = consumed;
    queuedTurn.messages = ensureTurnInputMessageOtids(queuedTurn.messages);
    await params.onConsumeQueuedTurn(queuedTurn);
    if (params.finishIfInterrupted(runId)) return { kind: "interrupted" };
    params.turnCorrelation.appendDequeuedBatch(dequeuedBatch.batchId);
    params.onDequeued(dequeuedBatch.batchId, queuedTurn.actingUserId ?? null);
    input = appendQueuedTurnToInput(input, queuedTurn);
    emitDequeuedUserMessage(socket, runtime, queuedTurn, dequeuedBatch);
  }

  setTurnLoopStatus(runtime, turnLease, "SENDING_API_REQUEST", {
    agent_id: agentId,
    conversation_id: conversationId,
  });
  const messages = params.deploymentInterrupted
    ? input.messages
    : injectQueuedSkillContent(input.messages, params);
  params.setInput(updateTurnInputMessagesPreservingOtids(input, messages));
  const result = await params.sender.send(messages);
  return params.finishIfInterrupted(runId)
    ? { kind: "interrupted" }
    : { kind: "sent", result };
}

export async function shouldRetryPostStopTurn(params: {
  deploymentInterrupted: boolean;
  deploymentAttempts: number;
  providerAttempts: number;
  stopReason: StopReasonType;
  runId: string | null | undefined;
  errorDetail: string | null;
}): Promise<boolean> {
  if (params.deploymentInterrupted) {
    return (
      params.deploymentAttempts < CLOUD_API_DEPLOYMENT_RECOVERY_MAX_ATTEMPTS
    );
  }
  if (params.providerAttempts >= getProviderRetryLimit(params.errorDetail))
    return false;
  return isRetriablePostStopError(
    params.stopReason,
    params.runId,
    params.errorDetail,
  );
}

export function createTurnInputSender(params: {
  conversationId: string;
  agentId: string | null;
  socket: ListenerTransport;
  runtime: ConversationRuntime;
  turnLease: TurnLease;
  buildSendOptions: () => Parameters<typeof sendMessageStream>[2];
  onTerminal: (transition: TurnFinishTransition) => void;
  finalizeTerminal: (
    options: Parameters<typeof finishListenerTurn>[2],
  ) => TurnFinishTransition;
  getTurnId: () => string;
  authorityGuard?: () => boolean;
}): {
  send: (
    input: Array<MessageCreate | ApprovalCreate>,
  ) => Promise<ApprovalContinuationSendResult>;
  accept: (
    result: ApprovalContinuationSendResult,
  ) => Stream<LettaStreamingResponse> | null;
} {
  return {
    async send(input) {
      if (isApprovalOnlyInput(input)) {
        return sendApprovalContinuationWithRetry(
          params.conversationId,
          input,
          params.buildSendOptions(),
          params.socket,
          params.runtime,
          params.turnLease,
          { authorityGuard: params.authorityGuard },
        );
      }
      return {
        kind: "stream",
        stream: await sendMessageStreamWithRetry(
          params.conversationId,
          input,
          params.buildSendOptions(),
          params.socket,
          params.runtime,
          params.turnLease,
          { authorityGuard: params.authorityGuard },
        ),
      };
    },
    accept(result) {
      if (result.kind === "stream") {
        return result.stream as Stream<LettaStreamingResponse>;
      }
      params.onTerminal(
        finalizeHandledRecoveryTurn(
          params.runtime,
          params.socket,
          {
            drainResult: result.drainResult,
            agentId: params.agentId,
            conversationId: params.conversationId,
            turnId: params.getTurnId(),
          },
          params.finalizeTerminal,
        ),
      );
      return null;
    },
  };
}
