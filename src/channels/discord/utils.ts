import { formatChannelLifecycleErrorMessage } from "@/channels/lifecycle-error";
import type { DiscordChannelAccount } from "@/channels/types";
import { formatDiscordDeliveryError } from "./error-reply";
import type {
  DiscordChannelLike,
  DiscordFetchedMessageLike,
  DiscordMessageLike,
} from "./internal-types";

const DISCORD_LIFECYCLE_ERROR_TEXT_MAX = 1500;

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function isDiscordTextChannel(
  channel: DiscordChannelLike | null,
): channel is DiscordChannelLike & {
  isTextBased: () => boolean;
} {
  return typeof channel?.isTextBased === "function" && channel.isTextBased();
}

export function hasDiscordMessageFetcher(
  channel: DiscordChannelLike | null,
): channel is DiscordChannelLike & {
  isTextBased: () => boolean;
  messages: {
    fetch: (id: string) => Promise<DiscordFetchedMessageLike>;
  };
} {
  return (
    isDiscordTextChannel(channel) &&
    !!channel.messages &&
    typeof channel.messages.fetch === "function"
  );
}

export function isDiscordSendableChannel(
  channel: DiscordChannelLike | null,
): channel is DiscordChannelLike & {
  isTextBased: () => boolean;
  send: (options: string | Record<string, unknown>) => Promise<{ id: string }>;
} {
  return isDiscordTextChannel(channel) && typeof channel.send === "function";
}

export function isDiscordTypingChannel(
  channel: DiscordChannelLike | null,
): channel is DiscordChannelLike & {
  isTextBased: () => boolean;
  sendTyping: () => Promise<unknown>;
} {
  return (
    isDiscordTextChannel(channel) && typeof channel.sendTyping === "function"
  );
}

export function splitMessageText(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) {
    return [text];
  }
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }
    // Try to split at a newline boundary
    let splitAt = remaining.lastIndexOf("\n", maxLength);
    if (splitAt <= 0) {
      splitAt = remaining.lastIndexOf(" ", maxLength);
    }
    if (splitAt <= 0) {
      splitAt = maxLength;
    }
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  return chunks;
}

export function normalizeDiscordMentionText(
  text: string,
  botUserId: string | null,
): string {
  if (!botUserId) return text;
  return text.replace(new RegExp(`<@!?${botUserId}>\\s*`, "g"), "").trim();
}

export function resolveDiscordChatType(
  guildId: string | null | undefined,
): "direct" | "channel" {
  return guildId ? "channel" : "direct";
}

/**
 * Resolve native emoji for Discord reactions.
 * Discord uses native Unicode emoji directly (not names like Slack).
 * Strip colons for common named patterns.
 */
export function resolveDiscordReactionEmoji(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("<:") || trimmed.startsWith("<a:")) {
    return trimmed;
  }
  const normalized = trimmed.replace(/^:+|:+$/g, "");
  // Common name-to-emoji mappings for parity with Slack lifecycle reactions
  const nameMap: Record<string, string> = {
    eyes: "👀",
    white_check_mark: "✅",
    x: "❌",
  };
  return nameMap[normalized] ?? normalized;
}

export function shouldAutoThreadOnDiscordMention(
  account: Pick<
    DiscordChannelAccount,
    "autoThreadOnMention" | "threadPolicyByChannel"
  >,
  channelId: string,
): boolean {
  const override = account.threadPolicyByChannel?.[channelId];
  if (typeof override === "boolean") return override;
  return account.autoThreadOnMention ?? false;
}

export function buildDiscordIngressMessageKey(
  accountId: string | undefined,
  messageId: string | undefined,
): string | null {
  if (!isNonEmptyString(accountId) || !isNonEmptyString(messageId)) {
    return null;
  }
  return `${accountId}:${messageId}`;
}

export function buildDiscordReplyOptions(
  replyToMessageId: string | undefined,
  channelId: string,
): { reply: { messageReference: string; failIfNotExists: false } } | undefined {
  const trimmed = replyToMessageId?.trim();
  if (!trimmed || trimmed === channelId) {
    return undefined;
  }
  return {
    reply: {
      messageReference: trimmed,
      failIfNotExists: false,
    },
  };
}

export function formatDiscordLifecycleErrorMessage(
  errorText: string,
  runId?: string | null,
): string {
  return formatChannelLifecycleErrorMessage(errorText, {
    codeBlock: true,
    maxLength: DISCORD_LIFECYCLE_ERROR_TEXT_MAX,
    runId,
  });
}

/**
 * Best-effort: post a user-facing error reply when forwarding a Discord
 * message to the agent runtime fails. Swallows any send failure so the
 * notification path can never crash the listener.
 */
export async function notifyDiscordDeliveryError(
  message: DiscordMessageLike,
  error: unknown,
): Promise<void> {
  try {
    if (typeof message.channel.send !== "function") return;
    const reply = buildDiscordReplyOptions(message.id, message.channelId);
    await message.channel.send({
      allowedMentions: { parse: [] },
      content: formatDiscordDeliveryError(error),
      ...(reply ?? {}),
    });
  } catch (sendError) {
    console.error(
      "[Discord] Failed to forward delivery error to user:",
      sendError,
    );
  }
}
