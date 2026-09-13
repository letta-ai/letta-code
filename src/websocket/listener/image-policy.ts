import {
  buildImageFailureModesByMessageOtid,
  type ImageFailureModesByMessageOtid,
} from "@/utils/message-image-normalization";
import type { IncomingMessage } from "./types";

export function getInboundImageFailureMode(
  incoming?: Pick<IncomingMessage, "imageFailureMode">,
): "strict" | "drop" {
  return incoming?.imageFailureMode ?? "strict";
}

export function getInboundImageFailureModes(
  incoming: Pick<IncomingMessage, "imageFailureMode" | "messages">,
): ImageFailureModesByMessageOtid | undefined {
  return getInboundImageFailureMode(incoming) === "drop"
    ? buildImageFailureModesByMessageOtid(incoming.messages, "drop")
    : undefined;
}
