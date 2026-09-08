import type {
  DiscordAttachmentLike,
  DiscordMessageLike,
} from "./internal-types";

const DISCORD_FORWARD_REFERENCE_TYPE = 1;

interface DiscordInboundPayload {
  text: string;
  attachments: Map<string, DiscordAttachmentLike>;
}

export function resolveDiscordInboundPayload(
  message: Pick<
    DiscordMessageLike,
    "attachments" | "content" | "messageSnapshots" | "reference"
  >,
  envelopeText: string = (message.content ?? "").trim(),
): DiscordInboundPayload {
  const attachments = new Map(message.attachments);
  if (message.reference?.type !== DISCORD_FORWARD_REFERENCE_TYPE) {
    return { text: envelopeText, attachments };
  }

  const snapshot = message.messageSnapshots?.values().next().value;
  if (!snapshot) {
    return { text: envelopeText, attachments };
  }

  for (const [id, attachment] of snapshot.attachments ?? []) {
    attachments.set(id, attachment);
  }

  const forwardedText = (snapshot.content ?? "").trim();
  const forwardedBlock = forwardedText
    ? `Forwarded message:\n${forwardedText}`
    : "Forwarded message";

  return {
    text: [envelopeText, forwardedBlock].filter(Boolean).join("\n\n"),
    attachments,
  };
}
