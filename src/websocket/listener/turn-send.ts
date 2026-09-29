import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type {
  ApprovalCreate,
  LettaStreamingResponse,
} from "@letta-ai/letta-client/resources/agents/messages";
import { sendMessageStream } from "@/agent/message";
import { getRetryDelayMs } from "@/agent/turn-recovery-policy";
import {
  exchangeNotificationSponsorship,
  NotificationSponsorshipExchangeError,
  type NotificationSponsorshipExchangeResult,
  type NotificationSponsorshipRequest,
} from "@/backend/api/request";
import { getRetryStatusMessage } from "@/cli/helpers/error-formatter";
import type { StopReasonType } from "@/types/protocol_v2";
import {
  CLOUD_API_DEPLOYMENT_RECOVERY_MAX_ATTEMPTS,
  LLM_API_ERROR_MAX_RETRIES,
} from "./constants";
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
import {
  refreshTurnInputOtidsForNewRequest,
  type TurnInputState,
  updateTurnInputMessagesPreservingOtids,
} from "./turn-input-state";
import type { TurnFinishTransition, TurnLease } from "./turn-lifecycle";
import type { ConversationRuntime } from "./types";

type SendOptions = NonNullable<Parameters<typeof sendMessageStream>[2]>;
const SPONSORSHIP_EXCHANGE_MAX_ATTEMPTS = 50;
const SPONSORSHIP_EXCHANGE_RETRY_MS = 100;
const SPONSORED_REQUEST_MAX_ATTEMPTS = 3;

async function waitForSponsorshipExchangeRetry(
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw new Error("Cancelled by user");
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      reject(new Error("Cancelled by user"));
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, SPONSORSHIP_EXCHANGE_RETRY_MS);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function exchangeNotificationSponsorshipWhenReady(
  request: NotificationSponsorshipRequest,
  signal?: AbortSignal,
  exchange: (
    request: NotificationSponsorshipRequest,
    signal?: AbortSignal,
  ) => Promise<NotificationSponsorshipExchangeResult> = exchangeNotificationSponsorship,
): Promise<NotificationSponsorshipExchangeResult> {
  for (
    let attempt = 1;
    attempt <= SPONSORSHIP_EXCHANGE_MAX_ATTEMPTS;
    attempt++
  ) {
    try {
      return await exchange(request, signal);
    } catch (error) {
      if (
        !(error instanceof NotificationSponsorshipExchangeError) ||
        error.status !== 409 ||
        attempt === SPONSORSHIP_EXCHANGE_MAX_ATTEMPTS
      ) {
        throw error;
      }
      await waitForSponsorshipExchangeRetry(signal);
    }
  }
  throw new Error("Notification sponsorship exchange attempts exhausted");
}

/** Build request options and perform the first send; later continuations read current input state. */
export async function startTurnInput(
  params: Omit<
    Parameters<typeof createTurnInputSender>[0],
    "buildSendOptions" | "notificationSponsorship"
  > & {
    workingDirectory: string;
    permissionModeState: SendOptions["permissionModeState"];
    preparedToolContext: SendOptions["preparedToolContext"];
    overrideModel: SendOptions["overrideModel"];
    responseFormat?: SendOptions["responseFormat"];
    actingUserId?: string;
    notificationSponsorship?: {
      delivery_id: string;
      client_message_id: string;
    };
    getInput: () => TurnInputState;
    getInterruptedToolCallIds: () => string[];
  },
) {
  const sendParams = {
    ...params,
    buildSendOptions: () => ({
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
      ...(params.overrideModel ? { overrideModel: params.overrideModel } : {}),
      ...(params.responseFormat
        ? { responseFormat: params.responseFormat }
        : {}),
      ...(params.actingUserId ? { actingUserId: params.actingUserId } : {}),
      notificationSponsorship: undefined,
      ...(params.getInterruptedToolCallIds().length > 0
        ? {
            approvalNormalization: {
              interruptedToolCallIds: params.getInterruptedToolCallIds(),
            },
          }
        : {}),
    }),
  };
  const input = params.getInput();
  const buildSafeSendOptions = () => ({
    ...sendParams.buildSendOptions(),
    notificationSponsorship: undefined,
  });
  if (params.notificationSponsorship) {
    const { delivery_id: deliveryId, client_message_id: clientMessageId } =
      params.notificationSponsorship;
    // Deferred skill prompts are unrelated user messages. Leave them queued
    // for the next ordinary turn so the sponsored request stays exactly one
    // message and no queued skill content is consumed on validation failure.
    const sponsoredMessages = input.messages;
    const firstUserMessage = sponsoredMessages.find(
      (message) =>
        "role" in message &&
        message.role === "user" &&
        "client_message_id" in message &&
        message.client_message_id === clientMessageId,
    );
    if (
      sponsoredMessages.length !== 1 ||
      !firstUserMessage ||
      !("otid" in firstUserMessage) ||
      firstUserMessage.otid !== clientMessageId
    ) {
      throw new Error(
        "Notification sponsorship does not match the queued initial user message",
      );
    }
    const safeSender = createTurnInputSender({
      ...sendParams,
      buildSendOptions: buildSafeSendOptions,
    });
    for (
      let attempt = 1;
      attempt <= SPONSORED_REQUEST_MAX_ATTEMPTS + 1;
      attempt++
    ) {
      const exchange = await exchangeNotificationSponsorshipWhenReady(
        { deliveryId, clientMessageId },
        params.turnLease.signal,
      );
      if (exchange.kind === "receipt") {
        return {
          sender: safeSender,
          buildSendOptions: buildSafeSendOptions,
          input,
          stream: null,
          reconciledReceipt: true,
        };
      }
      if (attempt > SPONSORED_REQUEST_MAX_ATTEMPTS) break;
      try {
        // Each one-use capability reaches exactly one SDK request with SDK and
        // Cloud-shutdown retries disabled. An ambiguous failure returns here
        // for a fresh exchange: a durable receipt suppresses a second send;
        // otherwise Cloud rotates a new capability for the next attempt.
        const initialStream = await sendMessageStream(
          params.conversationId,
          sponsoredMessages,
          {
            ...sendParams.buildSendOptions(),
            notificationSponsorship: {
              capability: exchange.capability,
              clientMessageId,
            },
          },
          params.turnLease.signal
            ? { maxRetries: 0, signal: params.turnLease.signal }
            : { maxRetries: 0 },
        );
        return {
          sender: safeSender,
          buildSendOptions: buildSafeSendOptions,
          input,
          stream: initialStream,
          reconciledReceipt: false,
        };
      } catch {
        // Reconcile through a new exchange before deciding whether another
        // request is safe. Never reuse the capability from this attempt.
      }
    }
    throw new Error(
      "The sponsored message could not be confirmed by Cloud after fresh-capability retries.",
    );
  }
  const withSkills = injectQueuedSkillContent(input.messages, params);
  const safeSender = createTurnInputSender({
    ...sendParams,
    buildSendOptions: buildSafeSendOptions,
  });
  const result = await safeSender.send(withSkills);
  return {
    sender: safeSender,
    buildSendOptions: buildSafeSendOptions,
    input: updateTurnInputMessagesPreservingOtids(input, withSkills),
    stream: safeSender.accept(result),
    reconciledReceipt: false,
  };
}

export async function prepareProviderRetryInput(params: {
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
  const delayMs = getRetryDelayMs({
    category: "transient_provider",
    attempt: params.attempt,
    detail: params.errorDetail,
  });
  emitRecoverableRetryNotice(params.socket, params.runtime, {
    kind: "transient_provider_retry",
    message:
      getRetryStatusMessage(params.errorDetail) ||
      `LLM API error encountered, retrying (attempt ${params.attempt}/${LLM_API_ERROR_MAX_RETRIES})...`,
    reason: "llm_api_error",
    attempt: params.attempt,
    maxAttempts: LLM_API_ERROR_MAX_RETRIES,
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
  if (params.providerAttempts >= LLM_API_ERROR_MAX_RETRIES) return false;
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
  getTurnId: () => string;
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
          params.turnLease,
          {
            drainResult: result.drainResult,
            agentId: params.agentId,
            conversationId: params.conversationId,
            turnId: params.getTurnId(),
          },
        ),
      );
      return null;
    },
  };
}
