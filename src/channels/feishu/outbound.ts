export type FeishuReceiveIdType =
  | "chat_id"
  | "open_id"
  | "user_id"
  | "union_id"
  | "email";

export interface FeishuCreateTextMessageRequest {
  params: { receive_id_type: FeishuReceiveIdType };
  data: {
    receive_id: string;
    msg_type: "text";
    content: string;
  };
}

export interface FeishuReplyTextMessageRequest {
  path: { message_id: string };
  data: {
    msg_type: "text";
    content: string;
    reply_in_thread?: boolean;
  };
}

export function buildFeishuTextContent(text: string): string {
  return JSON.stringify({ text });
}

/**
 * Build a Feishu/Lark IM create-message payload.
 *
 * v1 always sends `msg_type=text`. Group and p2p replies use `chat_id`
 * (the inbound event's `chat_id`) so MessageChannel can address the same
 * conversation the event came from.
 */
export function buildFeishuCreateTextMessage(options: {
  receiveId: string;
  receiveIdType?: FeishuReceiveIdType;
  text: string;
}): FeishuCreateTextMessageRequest {
  return {
    params: { receive_id_type: options.receiveIdType ?? "chat_id" },
    data: {
      receive_id: options.receiveId,
      msg_type: "text",
      content: buildFeishuTextContent(options.text),
    },
  };
}

export function buildFeishuReplyTextMessage(options: {
  messageId: string;
  text: string;
  replyInThread?: boolean;
}): FeishuReplyTextMessageRequest {
  return {
    path: { message_id: options.messageId },
    data: {
      msg_type: "text",
      content: buildFeishuTextContent(options.text),
      ...(options.replyInThread ? { reply_in_thread: true } : {}),
    },
  };
}
