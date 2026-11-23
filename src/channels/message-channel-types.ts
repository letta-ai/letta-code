import type { ChannelMessageActionName } from "@/channels/plugin-types";
import type { ChannelTurnSource, SupportedChannelId } from "@/channels/types";

export interface MessageChannelInput {
  channel: string;
  action: string;
  chat_id?: string;
  target?: string;
  accountId?: string;
  message?: string;
  replyTo?: string;
  threadId?: string | null;
  conversationId?: string;
  expectedConversationId?: string;
  messageId?: string;
  attachmentId?: string;
  emoji?: string;
  remove?: boolean;
  media?: string;
  filename?: string;
  title?: string;
}

export interface MessageChannelArgs extends MessageChannelInput {
  parentScope?: { agentId: string; conversationId: string };
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
