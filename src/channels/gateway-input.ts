import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type { InputCreateMessagePayload } from "@/types/protocol_v2";

/** Preserve caller-owned batches and input policies through channel tracking. */
export function buildGatewayInput(delivery: {
  content: MessageCreate["content"];
  clientMessageId: string;
  inputPayload?: InputCreateMessagePayload;
}): InputCreateMessagePayload {
  if (delivery.inputPayload) {
    const payload = delivery.inputPayload;
    if (payload.kind !== "create_message" || payload.messages.length === 0) {
      throw new Error("Channel input requires a nonempty create-message batch");
    }
    if (payload.messages[0]?.client_message_id !== delivery.clientMessageId) {
      throw new Error("Channel delivery ID must match the first input message");
    }
    return payload;
  }
  return {
    kind: "create_message",
    messages: [
      {
        role: "user",
        content: delivery.content,
        client_message_id: delivery.clientMessageId,
      },
    ],
    image_failure_mode: "drop",
  };
}
