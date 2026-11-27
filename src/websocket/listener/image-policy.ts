import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import {
  buildImageFailureModesByMessageOtid,
  type ImageFailureModesByMessageOtid,
} from "@/utils/message-image-normalization";
import type { IncomingMessage } from "./types";

export function hasImageContent(content: MessageCreate["content"]): boolean {
  return (
    Array.isArray(content) && content.some((part) => part.type === "image")
  );
}

export function getInboundImageFailureMode(
  incoming?: Pick<IncomingMessage, "imageFailureMode">,
): "strict" | "drop" {
  return incoming?.imageFailureMode ?? "strict";
}

export function getInboundImageFailureModes(
  incoming: Pick<IncomingMessage, "imageFailureMode" | "messages">,
): ImageFailureModesByMessageOtid | undefined {
  return getInboundImageFailureMode(incoming) === "drop"
    ? buildImageFailureModesByMessageOtid(
        incoming.messages.filter(
          (message) => "content" in message && hasImageContent(message.content),
        ),
        "drop",
      )
    : undefined;
}
