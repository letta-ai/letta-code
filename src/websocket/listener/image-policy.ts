import {
  buildImageFailureModesByMessageOtid,
  type ImageFailureModesByMessageOtid,
} from "@/utils/message-image-normalization";
import type { IncomingMessage } from "./types";

export function getInboundImageFailureModes(
  incoming: Pick<IncomingMessage, "channelTurnSources" | "messages">,
): ImageFailureModesByMessageOtid | undefined {
  return (incoming.channelTurnSources?.length ?? 0) > 0
    ? buildImageFailureModesByMessageOtid(incoming.messages, "drop")
    : undefined;
}
