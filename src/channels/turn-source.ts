import type { ChannelTurnSource } from "@/channels/types";

/** Stable identity for comparing complete channel-turn provenance records. */
export function channelTurnSourceIdentity(source: ChannelTurnSource): string {
  return JSON.stringify([
    source.channel,
    source.accountId ?? null,
    source.chatId,
    source.chatType ?? null,
    source.senderId ?? null,
    source.senderTeamId ?? null,
    source.messageId ?? null,
    source.threadId ?? null,
    source.agentId,
    source.conversationId,
  ]);
}

/** Thread used when routing output back to the source turn. */
export function effectiveChannelTurnSourceThreadId(
  source: ChannelTurnSource,
): string | null {
  if (source.threadId !== undefined && source.threadId !== null) {
    return source.threadId;
  }
  if (source.channel === "slack" && source.chatType !== "direct") {
    return source.messageId ?? null;
  }
  return null;
}
