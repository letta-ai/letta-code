import type { ChannelMessageActionName } from "@/channels/plugin-types";
import type { ChannelTurnSource, SupportedChannelId } from "@/channels/types";

export interface MessageChannelArgs {
  channel: string;
  action: string;
  chat_id?: string;
  target?: string;
  accountId?: string;
  message?: string;
  replyTo?: string;
  threadId?: string;
  messageId?: string;
  attachmentId?: string;
  emoji?: string;
  remove?: boolean;
  media?: string;
  filename?: string;
  title?: string;
  /** Injected by executeTool() — NOT read from global context. */
  parentScope?: { agentId: string; conversationId: string };
  /** Injected by executeTool() for channel-originated turns. */
  channelTurnSources?: ChannelTurnSource[];
}

export interface NormalizedMessageChannelInput {
  channel: SupportedChannelId;
  action: ChannelMessageActionName;
  chatId?: string;
  target?: string;
  accountId?: string;
  message?: string;
  replyToMessageId?: string;
  threadId?: string | null;
  messageId?: string;
  attachmentId?: string;
  emoji?: string;
  remove?: boolean;
  mediaPath?: string;
  filename?: string;
  title?: string;
}
