import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type { ApprovalCreate } from "@letta-ai/letta-client/resources/agents/messages";
import type { ImageFailureModesByMessageOtid } from "@/utils/message-image-normalization";
import { getInboundImageFailureModes } from "./image-policy";
import type { IncomingMessage } from "./types";

export function appendQueuedTurnToInput(
  input: Array<MessageCreate | ApprovalCreate>,
  queuedTurn: IncomingMessage,
): {
  input: Array<MessageCreate | ApprovalCreate>;
  imageFailureModesByMessageOtid?: ImageFailureModesByMessageOtid;
} {
  return {
    input: [...input, ...queuedTurn.messages],
    imageFailureModesByMessageOtid: getInboundImageFailureModes(queuedTurn),
  };
}
