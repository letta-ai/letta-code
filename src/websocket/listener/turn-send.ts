import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type {
  ApprovalCreate,
  LettaStreamingResponse,
} from "@letta-ai/letta-client/resources/agents/messages";
import type { sendMessageStream } from "@/agent/message";
import { finalizeHandledRecoveryTurn } from "./recovery";
import {
  type ApprovalContinuationSendResult,
  isApprovalOnlyInput,
  sendApprovalContinuationWithRetry,
  sendMessageStreamWithRetry,
} from "./send";
import { injectQueuedSkillContent } from "./skill-injection";
import type { ListenerTransport } from "./transport";
import {
  type TurnInputState,
  updateTurnInputMessagesPreservingOtids,
} from "./turn-input-state";
import type { TurnFinishTransition, TurnLease } from "./turn-lifecycle";
import type { ConversationRuntime } from "./types";

type SendOptions = NonNullable<Parameters<typeof sendMessageStream>[2]>;

/** Build request options and perform the first send; later continuations read current input state. */
export async function startTurnInput(
  params: Omit<
    Parameters<typeof createTurnInputSender>[0],
    "buildSendOptions"
  > & {
    workingDirectory: string;
    permissionModeState: SendOptions["permissionModeState"];
    preparedToolContext: SendOptions["preparedToolContext"];
    overrideModel: SendOptions["overrideModel"];
    actingUserId?: string;
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
      ...(params.actingUserId ? { actingUserId: params.actingUserId } : {}),
      ...(params.getInterruptedToolCallIds().length > 0
        ? {
            approvalNormalization: {
              interruptedToolCallIds: params.getInterruptedToolCallIds(),
            },
          }
        : {}),
    }),
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
