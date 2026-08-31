import type { FeishuGroupMode, InboundChannelMessage } from "@/channels/types";
import { isRecord } from "@/utils/type-guards";

export interface FeishuSenderId {
  open_id?: string;
  user_id?: string;
  union_id?: string;
}

export interface FeishuMention {
  key?: string;
  name?: string;
  mentioned_type?: string;
  id?: FeishuSenderId;
}

export interface FeishuReceiveMessage {
  message_id?: string;
  root_id?: string;
  parent_id?: string;
  create_time?: string;
  chat_id?: string;
  chat_type?: string;
  message_type?: string;
  content?: string;
  thread_id?: string;
  mentions?: FeishuMention[];
}

export interface FeishuReceiveSender {
  sender_id?: FeishuSenderId;
  sender_type?: string;
  tenant_key?: string;
}

export interface FeishuReceiveEventBody {
  sender?: FeishuReceiveSender;
  message?: FeishuReceiveMessage;
}

export type FeishuIngressDropReason =
  | "malformed"
  | "bot_sender"
  | "self_sender"
  | "mention_required"
  | "broadcast_all"
  | "empty";

export type FeishuIngressDecision =
  | { action: "drop"; reason: FeishuIngressDropReason }
  | { action: "deliver"; inbound: InboundChannelMessage };

const MENTION_KEY_RE = /@_user_\d+/g;
const BROADCAST_ALL_TEXT_RE = /@_all\b|@all\b/i;
const MEDIA_PLACEHOLDERS: Record<string, string> = {
  image: "[image]",
  file: "[file]",
  audio: "[audio]",
  media: "[video]",
  sticker: "[sticker]",
  interactive: "[card]",
  share_chat: "[shared chat]",
  share_user: "[shared user]",
  merge_forward: "[forwarded messages]",
  system: "[system]",
};

export function unwrapFeishuReceiveEvent(
  payload: unknown,
): FeishuReceiveEventBody | null {
  if (!isRecord(payload)) {
    return null;
  }
  if (isRecord(payload.event)) {
    return payload.event as FeishuReceiveEventBody;
  }
  if (isRecord(payload.message) || isRecord(payload.sender)) {
    return payload as FeishuReceiveEventBody;
  }
  return null;
}

export function stripFeishuMentionKeys(text: string): string {
  return text
    .replace(MENTION_KEY_RE, " ")
    .replace(/@_all/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isBroadcastAllMention(mention: FeishuMention): boolean {
  const key = mention.key?.trim().toLowerCase();
  return key === "@_all" || key === "@all";
}

export function isFeishuBroadcastAllOnly(
  text: string,
  mentions: FeishuMention[],
): boolean {
  const hasAllMention = mentions.some(isBroadcastAllMention);
  const hasAllText = BROADCAST_ALL_TEXT_RE.test(text);
  if (!hasAllMention && !hasAllText) {
    return false;
  }
  return !mentions.some((mention) => !isBroadcastAllMention(mention));
}

export function isFeishuBotMention(
  mentions: FeishuMention[],
  botOpenId?: string | null,
): boolean {
  if (mentions.some((mention) => mention.mentioned_type === "bot")) {
    return true;
  }
  const trimmedBotOpenId = botOpenId?.trim();
  if (!trimmedBotOpenId) {
    return false;
  }
  return mentions.some((mention) => mention.id?.open_id === trimmedBotOpenId);
}

function extractPostText(value: unknown): string {
  if (!isRecord(value)) {
    return "";
  }
  const localized =
    (isRecord(value.zh_cn) ? value.zh_cn : null) ??
    (isRecord(value.en_us) ? value.en_us : null) ??
    value;
  if (!isRecord(localized)) {
    return "";
  }
  const title =
    typeof localized.title === "string" ? localized.title.trim() : "";
  const chunks: string[] = [];
  if (Array.isArray(localized.content)) {
    for (const row of localized.content) {
      if (!Array.isArray(row)) continue;
      for (const node of row) {
        if (!isRecord(node)) continue;
        if (typeof node.text === "string" && node.text.trim()) {
          chunks.push(node.text);
        }
      }
    }
  }
  const body = stripFeishuMentionKeys(chunks.join(" "));
  if (title && body) return `${title}\n${body}`;
  return title || body;
}

export function extractFeishuMessageText(
  messageType: string | undefined,
  contentRaw: string | undefined,
): string {
  const type = (messageType ?? "text").trim() || "text";
  const raw = contentRaw ?? "";
  if (!raw.trim()) {
    return MEDIA_PLACEHOLDERS[type] ?? (type === "text" ? "" : `[${type}]`);
  }

  let parsed: unknown = raw;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return stripFeishuMentionKeys(raw) || `[${type}]`;
  }

  if (type === "text") {
    const text =
      isRecord(parsed) && typeof parsed.text === "string" ? parsed.text : "";
    return stripFeishuMentionKeys(text);
  }
  if (type === "post") {
    return extractPostText(parsed) || "[post]";
  }
  return MEDIA_PLACEHOLDERS[type] ?? `[${type}]`;
}

function parseCreateTime(value: string | undefined): number {
  if (!value) return Date.now();
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

export function evaluateFeishuReceiveEvent(
  payload: unknown,
  options: {
    accountId: string;
    groupMode?: FeishuGroupMode;
    botOpenId?: string | null;
  },
): FeishuIngressDecision {
  const event = unwrapFeishuReceiveEvent(payload);
  const message = event?.message;
  const sender = event?.sender;
  const chatId = message?.chat_id?.trim();
  const messageId = message?.message_id?.trim();
  const senderId = sender?.sender_id?.open_id?.trim();
  if (!event || !message || !chatId || !messageId || !senderId) {
    return { action: "drop", reason: "malformed" };
  }

  const senderType = sender?.sender_type?.trim().toLowerCase();
  if (senderType === "bot" || senderType === "app") {
    return { action: "drop", reason: "bot_sender" };
  }

  const botOpenId = options.botOpenId?.trim() || null;
  if (botOpenId && senderId === botOpenId) {
    return { action: "drop", reason: "self_sender" };
  }

  const mentions = Array.isArray(message.mentions) ? message.mentions : [];
  const rawContent = message.content ?? "";
  const rawText =
    typeof rawContent === "string" ? rawContent : JSON.stringify(rawContent);
  const text = extractFeishuMessageText(message.message_type, rawText);
  const chatType = message.chat_type === "p2p" ? "direct" : "channel";
  const isBotMention = isFeishuBotMention(mentions, botOpenId);
  const broadcastAllOnly = isFeishuBroadcastAllOnly(rawText, mentions);
  const groupMode = options.groupMode ?? "mention-only";

  if (chatType === "channel") {
    if (broadcastAllOnly && !isBotMention) {
      return { action: "drop", reason: "broadcast_all" };
    }
    if (groupMode === "mention-only" && !isBotMention) {
      return { action: "drop", reason: "mention_required" };
    }
  }

  if (!text && !isBotMention && chatType !== "direct") {
    return { action: "drop", reason: "empty" };
  }

  const inbound: InboundChannelMessage = {
    channel: "feishu",
    accountId: options.accountId,
    chatId,
    senderId,
    senderName:
      mentions.find((mention) => mention.id?.open_id === senderId)?.name ??
      senderId,
    text,
    timestamp: parseCreateTime(message.create_time),
    messageId,
    threadId: message.thread_id?.trim() || null,
    chatType,
    isMention: chatType === "direct" ? false : isBotMention,
    routedBy:
      chatType === "direct" ? "dm" : isBotMention ? "mention" : undefined,
    isOpenChannel:
      chatType === "channel" && groupMode === "open" && !isBotMention,
    raw: payload,
  };

  return { action: "deliver", inbound };
}
