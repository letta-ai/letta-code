import {
  buildImageFailureModesByMessageOtid,
  type ImageFailureModesByMessageOtid,
} from "@/utils/message-image-normalization";
import type { IncomingMessage } from "./types";

export function getInboundImageFailureMode(
  incoming?: Pick<IncomingMessage, "channelTurnSources">,
): "strict" | "drop" {
  return (incoming?.channelTurnSources?.length ?? 0) > 0 ? "drop" : "strict";
}

export function getInboundImageFailureModes(
  incoming: Pick<IncomingMessage, "channelTurnSources" | "messages">,
): ImageFailureModesByMessageOtid | undefined {
  return getInboundImageFailureMode(incoming) === "drop"
    ? buildImageFailureModesByMessageOtid(incoming.messages, "drop")
    : undefined;
}
