import { mergeImageFailureModesByMessageOtid } from "@/utils/message-image-normalization";
import { getInboundImageFailureModes } from "./image-policy";
import { createTurnInputState, type TurnInputState } from "./turn-input-state";
import type { IncomingMessage } from "./types";

export function appendQueuedTurnToInput(
  state: TurnInputState,
  queuedTurn: IncomingMessage,
): TurnInputState {
  return createTurnInputState(
    [...state.messages, ...queuedTurn.messages],
    mergeImageFailureModesByMessageOtid(
      state.imageFailureModesByMessageOtid,
      getInboundImageFailureModes(queuedTurn),
    ),
  );
}
