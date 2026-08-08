import type { DiscordAllowBotsMode } from "@/channels/types";

interface DiscordBotPolicyMessage {
  content?: unknown;
  author?: {
    id?: unknown;
    bot?: unknown;
  } | null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function isValidDiscordAllowBotsConfigValue(
  value: unknown,
): value is DiscordAllowBotsMode | undefined {
  return value === undefined || value === false || value === "mentions";
}

export function normalizeDiscordAllowBotsMode(
  value: unknown,
): DiscordAllowBotsMode {
  return value === "mentions" ? "mentions" : false;
}

export function hasExplicitDiscordUserMention(
  message: Pick<DiscordBotPolicyMessage, "content">,
  userId: string | null | undefined,
): boolean {
  if (!isNonEmptyString(userId) || typeof message.content !== "string") {
    return false;
  }
  return (
    message.content.includes(`<@${userId}>`) ||
    message.content.includes(`<@!${userId}>`)
  );
}

export function shouldAcceptDiscordInboundBotMessage(input: {
  message: DiscordBotPolicyMessage;
  allowBots?: DiscordAllowBotsMode;
  botUserId: string | null;
  wasExplicitlyMentioned: boolean;
}): boolean {
  const author = input.message.author;
  if (author?.bot !== true) return true;

  if (isNonEmptyString(input.botUserId) && author.id === input.botUserId) {
    return false;
  }

  return input.allowBots === "mentions" && input.wasExplicitlyMentioned;
}
