import {
  ensureChannelRuntimeInstalled,
  installChannelRuntime,
  isChannelRuntimeInstalled,
  loadChannelRuntimeModule,
} from "@/channels/runtime-deps";

export interface XChatSdkAttachmentLike {
  type?: "image" | "file" | "audio" | "video";
  name?: string;
  mimeType?: string;
  size?: number;
  width?: number;
  height?: number;
  fetchData?: () => Promise<Buffer | Blob | ArrayBuffer | Uint8Array>;
}

export interface XChatSdkMessageLike {
  id: string;
  text: string;
  isMention?: boolean;
  author: {
    userId: string;
    userName?: string;
    fullName?: string;
    isMe?: boolean;
  };
  metadata: {
    dateSent: Date;
  };
  attachments?: XChatSdkAttachmentLike[];
  raw?: unknown;
}

export interface XChatSdkAdapterLike {
  readonly botUserId?: string;
  readonly cryptoStatus: string;
  readonly userName: string;
  initialize(host: unknown): Promise<void>;
  disconnect?(): Promise<void>;
  fetchMessages(
    threadId: string,
    options?: { limit?: number; cursor?: string },
  ): Promise<{ messages: XChatSdkMessageLike[]; nextCursor?: string }>;
  postMessage(
    threadId: string,
    message:
      | string
      | {
          raw: string;
          files?: Array<{
            data: Uint8Array;
            filename: string;
            mimeType?: string;
          }>;
        },
  ): Promise<{ id: string }>;
  addReaction(
    threadId: string,
    messageId: string,
    emoji: string,
  ): Promise<void>;
  removeReaction(
    threadId: string,
    messageId: string,
    emoji: string,
  ): Promise<void>;
  markAsRead?(
    threadId: string,
    messageId: string,
    message?: XChatSdkMessageLike,
  ): Promise<void>;
}

export interface XChatSdkModuleLike {
  createXchatAdapter(config: {
    botToken: string;
    pin: string;
    verifySignatures?: boolean;
    sendReadReceipts?: boolean;
    logger?: XChatSdkLoggerLike;
  }): XChatSdkAdapterLike;
}

export interface XChatSdkLoggerLike {
  debug(message: string, metadata?: unknown): void;
  info(message: string, metadata?: unknown): void;
  warn(message: string, metadata?: unknown): void;
  error(message: string, metadata?: unknown): void;
  child?(prefix: string): XChatSdkLoggerLike;
}

export interface XChatConversationLike {
  id?: string;
  conversationId?: string;
  conversation_id?: string;
}

export interface XChatApiClientLike {
  chat: {
    getConversation?(conversationId: string): Promise<{
      data?: XChatConversationLike;
    }>;
    getConversations(options?: {
      maxResults?: number;
      paginationToken?: string;
      chatConversationFields?: string[];
    }): Promise<{
      data?: XChatConversationLike[];
      meta?: { nextToken?: string; next_token?: string };
    }>;
  };
  users: {
    getMe(): Promise<{
      data?: { id?: string; username?: string; name?: string };
    }>;
    getPublicKey(
      userId: string,
      options?: { publicKeyFields?: string[] },
    ): Promise<{ data?: Array<Record<string, unknown>> }>;
  };
  activity?: {
    createSubscription(body: {
      eventType: string;
      filter: { userId: string };
    }): Promise<unknown>;
  };
  stream?: {
    activity(options?: {
      backfillMinutes?: number;
      signal?: AbortSignal;
    }): Promise<XChatActivityStreamLike>;
  };
}

export interface XChatActivityStreamLike extends AsyncIterable<unknown> {
  close(): void;
  reader?: { cancel(reason?: unknown): Promise<void> };
}

export interface XChatXdkModuleLike {
  Client: new (config: {
    accessToken?: string;
    bearerToken?: string;
    baseUrl?: string;
    headers?: Record<string, string>;
  }) => XChatApiClientLike;
}

let loadXChatSdkOverride: (() => Promise<XChatSdkModuleLike>) | null = null;
let loadXChatXdkOverride: (() => Promise<XChatXdkModuleLike>) | null = null;

export function __testOverrideXChatRuntime(
  params: {
    sdk?: (() => Promise<XChatSdkModuleLike>) | null;
    xdk?: (() => Promise<XChatXdkModuleLike>) | null;
  } | null,
): void {
  loadXChatSdkOverride = params?.sdk ?? null;
  loadXChatXdkOverride = params?.xdk ?? null;
}

export async function loadXChatSdkModule(): Promise<XChatSdkModuleLike> {
  if (loadXChatSdkOverride) return loadXChatSdkOverride();
  return loadChannelRuntimeModule<XChatSdkModuleLike>(
    "xchat",
    "@chat-adapter/x/chat",
  );
}

export async function loadXChatXdkModule(): Promise<XChatXdkModuleLike> {
  if (loadXChatXdkOverride) return loadXChatXdkOverride();
  return loadChannelRuntimeModule<XChatXdkModuleLike>(
    "xchat",
    "@xdevplatform/xdk",
  );
}

export function isXChatRuntimeInstalled(): boolean {
  return isChannelRuntimeInstalled("xchat");
}

export async function installXChatRuntime(): Promise<void> {
  await installChannelRuntime("xchat");
}

export async function ensureXChatRuntimeInstalled(): Promise<boolean> {
  return ensureChannelRuntimeInstalled("xchat");
}
