import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type {
  ApprovalCreate,
  LettaStreamingResponse,
} from "@letta-ai/letta-client/resources/agents/messages";
import type { sendMessageStream } from "@/agent/message";
import type { ConversationPermissionModeState } from "./permission-mode";
import {
  type ProviderFallbackState,
  resolveTurnRequestOverrideModel,
} from "./provider-fallback";
import { finalizeHandledRecoveryTurn } from "./recovery";
import {
  type ApprovalContinuationSendResult,
  isApprovalOnlyInput,
  sendApprovalContinuationWithRetry,
  sendMessageStreamWithRetry,
} from "./send";
import type { ListenerTransport } from "./transport";
import type { TurnInputState } from "./turn-input-state";
import type { TurnFinishTransition, TurnLease } from "./turn-lifecycle";
import type { ConversationRuntime } from "./types";

type SendOptions = NonNullable<Parameters<typeof sendMessageStream>[2]>;

/**
 * Build the per-request send options for one listener turn.
 *
 * The returned builder is re-evaluated for every request of the turn (initial
 * send, tool-call approval continuations, retries). It pins the turn-start
 * effective model on each request via override_model: a turn spans multiple
 * HTTP requests and the server re-resolves the effective model per request,
 * so an agent/conversation PATCH landing mid-turn would otherwise switch the
 * model between tool calls while tool schemas stay pinned to the turn-start
 * toolset. Precedence: provider fallback > live /model switch > turn-start
 * snapshot (see resolveTurnRequestOverrideModel).
 */
export function createTurnSendOptionsBuilder(params: {
  agentId: string;
  workingDirectory: string;
  permissionModeState: ConversationPermissionModeState;
  runtime: ConversationRuntime;
  preparedToolContext: SendOptions["preparedToolContext"];
  /** Turn-start resolved model (conversation override → agent fallback). */
  turnStartEffectiveModel: string | null;
  providerFallback: ProviderFallbackState;
  actingUserId: string | undefined;
  getTurnInput: () => TurnInputState;
  getPendingNormalizationInterruptedToolCallIds: () => string[];
}): () => SendOptions {
  return () => {
    const turnInput = params.getTurnInput();
    const pendingNormalizationInterruptedToolCallIds =
      params.getPendingNormalizationInterruptedToolCallIds();
    const overrideModel = resolveTurnRequestOverrideModel({
      providerFallbackOverride: params.providerFallback.overrideModel,
      liveModelSwitchHandle: params.runtime.liveModelSwitchHandle,
      turnStartEffectiveModel: params.turnStartEffectiveModel,
    });
    return {
      agentId: params.agentId,
      streamTokens: true,
      background: true,
      workingDirectory: params.workingDirectory,
      permissionModeState: params.permissionModeState,
      ...(params.runtime.skillSources !== undefined
        ? { skillSources: params.runtime.skillSources }
        : {}),
      preparedToolContext: params.preparedToolContext,
      ...(turnInput.imageFailureModesByMessageOtid
        ? {
            imageFailureModesByMessageOtid:
              turnInput.imageFailureModesByMessageOtid,
          }
        : {}),
      ...(overrideModel ? { overrideModel } : {}),
      ...(params.actingUserId ? { actingUserId: params.actingUserId } : {}),
      ...(pendingNormalizationInterruptedToolCallIds.length > 0
        ? {
            approvalNormalization: {
              interruptedToolCallIds:
                pendingNormalizationInterruptedToolCallIds,
            },
          }
        : {}),
    };
  };
}

export function createTurnInputSender(params: {
  conversationId: string;
  agentId: string;
  socket: ListenerTransport;
  runtime: ConversationRuntime;
  turnLease: TurnLease;
  providerFallback: ProviderFallbackState;
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
          { providerFallback: params.providerFallback },
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
          { providerFallback: params.providerFallback },
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
