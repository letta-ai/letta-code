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
import type { ListenerTransport } from "./transport";
import type { TurnFinishTransition, TurnLease } from "./turn-lifecycle";
import type { ConversationRuntime } from "./types";

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
