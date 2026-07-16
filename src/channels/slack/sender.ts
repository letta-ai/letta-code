import type { OutboundChannelMessage } from "@/channels/types";
import {
  normalizeSlackReactionName,
  resolveSlackOutboundThreadTs,
} from "./public-utils";

export interface SlackSenderPostMessageParams {
  channel: string;
  text: string;
  threadTs?: string;
  blocks?: unknown[];
}

export interface SlackSenderPostMessageResult {
  messageId: string;
}

export interface SlackSenderMessageResult {
  messageId: string;
}

export interface SlackSenderReactionParams {
  channel: string;
  timestamp: string;
  name: string;
}

export interface SlackSenderClient {
  postMessage(
    params: SlackSenderPostMessageParams,
  ): Promise<SlackSenderPostMessageResult>;
  addReaction?(params: SlackSenderReactionParams): Promise<void>;
  removeReaction?(params: SlackSenderReactionParams): Promise<void>;
}

export interface SlackChannelSender {
  sendMessage(
    message: OutboundChannelMessage,
  ): Promise<SlackSenderMessageResult>;
  sendDirectReply(params: SlackDirectReplyParams): Promise<void>;
}

export interface SlackDirectReplyParams {
  chatId: string;
  text: string;
  replyToMessageId?: string;
  threadId?: string | null;
  blocks?: unknown[];
}

export interface CreateSlackChannelSenderParams {
  client: SlackSenderClient;
}

async function sendSlackReaction(
  client: SlackSenderClient,
  message: OutboundChannelMessage,
): Promise<SlackSenderMessageResult> {
  const targetMessageId = message.targetMessageId ?? message.replyToMessageId;
  if (!targetMessageId) {
    throw new Error(
      "Slack reactions require message_id (or reply_to_message_id) to identify the target message.",
    );
  }
  const name = normalizeSlackReactionName(message.reaction ?? "");
  if (!name) {
    throw new Error("Slack reaction emoji cannot be empty.");
  }
  const params: SlackSenderReactionParams = {
    channel: message.chatId,
    timestamp: targetMessageId,
    name,
  };
  if (message.removeReaction) {
    if (!client.removeReaction) {
      throw new Error(
        "Slack sender client does not support removing reactions.",
      );
    }
    await client.removeReaction(params);
  } else {
    if (!client.addReaction) {
      throw new Error("Slack sender client does not support adding reactions.");
    }
    await client.addReaction(params);
  }
  return { messageId: targetMessageId };
}

export function createSlackChannelSender(
  params: CreateSlackChannelSenderParams,
): SlackChannelSender {
  const { client } = params;
  return {
    async sendMessage(
      message: OutboundChannelMessage,
    ): Promise<SlackSenderMessageResult> {
      if (message.reaction) {
        return await sendSlackReaction(client, message);
      }
      const threadTs = resolveSlackOutboundThreadTs({
        chatId: message.chatId,
        threadId: message.threadId,
        replyToMessageId: message.replyToMessageId,
      });
      return await client.postMessage({
        channel: message.chatId,
        text: message.text,
        ...(threadTs ? { threadTs } : {}),
      });
    },

    async sendDirectReply(params: SlackDirectReplyParams): Promise<void> {
      const threadTs = resolveSlackOutboundThreadTs({
        chatId: params.chatId,
        threadId: params.threadId,
        replyToMessageId: params.replyToMessageId,
      });
      await client.postMessage({
        channel: params.chatId,
        text: params.text,
        ...(params.blocks ? { blocks: params.blocks } : {}),
        ...(threadTs ? { threadTs } : {}),
      });
    },
  };
}
