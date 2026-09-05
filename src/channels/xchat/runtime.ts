import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ensureChannelRuntimeInstalled,
  getChannelRuntimeSearchPaths,
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

export interface XChatSdkIncomingEventLike {
  id: string;
  conversationId: string;
  senderId: string;
  encodedEvent: string;
  conversationKeyVersion?: unknown;
  conversationKeyChangeEvent?: unknown;
  conversationToken?: unknown;
  encryptedConversationKey?: unknown;
  createdAtMsec?: unknown;
  messageEventSignature?: unknown;
  sequenceId?: string;
}

export interface XChatSdkReactionLike {
  added: boolean;
  emoji?: { name?: string };
  rawEmoji?: string;
  messageId: string;
  threadId: string;
  user: {
    userId: string;
    userName?: string;
    fullName?: string;
    isMe?: boolean;
  };
  raw?: unknown;
}

export interface XChatSdkWebhookOptionsLike {
  waitUntil?(task: Promise<unknown>): void;
}

export interface XChatSdkAdapterLike {
  readonly botUserId?: string;
  readonly cryptoStatus: string;
  readonly userName: string;
  getXdkClient?(): XChatApiClientLike;
  initialize(host: unknown): Promise<void>;
  disconnect?(): Promise<void>;
  fetchMessages(
    threadId: string,
    options?: { limit?: number; cursor?: string },
  ): Promise<{ messages: XChatSdkMessageLike[]; nextCursor?: string }>;
  handleIncomingEvent?(
    event: XChatSdkIncomingEventLike,
  ): Promise<XChatSdkMessageLike | null>;
  handleWebhook?(
    request: Request,
    options?: XChatSdkWebhookOptionsLike,
  ): Promise<Response>;
  startTyping?(threadId: string): Promise<void>;
  stopTyping?(conversationId: string): void;
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
    signingKeyVersion?: string;
    verifySignatures?: boolean;
    disableWebhookVerification?: boolean;
    sendReadReceipts?: boolean;
    logger?: XChatSdkLoggerLike;
  }): XChatSdkAdapterLike;
}

export interface XChatRegistrationPublicKeyLike {
  identityPublicKeySignature: string;
  publicKey: string;
  publicKeyFingerprint: string;
  registrationMethod: string;
  signingPublicKey: string;
  signingPublicKeySignature: string;
}

export interface XChatRegistrationPayloadLike {
  publicKey: XChatRegistrationPublicKeyLike;
  version: string;
  generateVersion: boolean;
}

export interface XChatRawCryptoLike {
  exportKeys(): Uint8Array;
  free(): void;
  generateKeypairs(): XChatRegistrationPayloadLike;
  getPublicKeyFingerprint(): string;
  getPublicKeys(): { identity: string; signing: string; version: string };
  importKeys(keys: Uint8Array, version?: string): void;
  lock(): void;
  matchesRegisteredKey(publicKey: string): boolean;
  verifyKeyBinding(
    identityPublicKey: string,
    signingPublicKey: string,
    identityPublicKeySignature: string,
  ): boolean;
}

export interface XChatRawCryptoModuleLike {
  Chat: new () => XChatRawCryptoLike;
  default(options: { module_or_path: Uint8Array }): Promise<unknown>;
}

export interface XChatJuiceboxChatLike {
  free(): void;
  getPublicKeyFingerprint(): string;
  getPublicKeys(): { identity: string; signing: string; version: string };
  matchesRegisteredKey(publicKey: string): boolean;
  unlock(pin: string | Uint8Array): Promise<void>;
}

export interface XChatCryptoSdkModuleLike {
  createChat(options: {
    getAuthToken(realmId: string): Promise<string>;
    juiceboxConfig?: string;
  }): Promise<XChatJuiceboxChatLike>;
  juiceboxClientConfig(config: Record<string, unknown>): unknown;
  resolveMaxGuessCount(
    config: Record<string, unknown>,
    maxGuessCount?: number,
  ): number;
}

export interface XChatJuiceboxClientLike {
  free(): void;
  register(
    pin: Uint8Array,
    secret: Uint8Array,
    info: Uint8Array,
    numGuesses: number,
  ): Promise<void>;
}

export interface XChatJuiceboxConfigurationLike {
  free(): void;
}

export interface XChatJuiceboxSdkModuleLike {
  Client: new (
    configuration: XChatJuiceboxConfigurationLike,
    previousConfigurations: XChatJuiceboxConfigurationLike[],
  ) => XChatJuiceboxClientLike;
  Configuration: new (config: unknown) => XChatJuiceboxConfigurationLike;
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
    mediaUploadInitialize?(body: {
      conversationId: string;
      totalBytes: number;
    }): Promise<unknown>;
    mediaUploadAppend?(
      sessionId: string,
      body: {
        conversationId: string;
        mediaHashKey: string;
        media: string;
        segmentIndex: number;
      },
    ): Promise<unknown>;
    mediaUploadFinalize?(
      sessionId: string,
      body: {
        conversationId: string;
        mediaHashKey: string;
        numParts: string;
      },
    ): Promise<unknown>;
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
let loadXChatCryptoSdkOverride:
  | (() => Promise<XChatCryptoSdkModuleLike>)
  | null = null;
let loadXChatRawCryptoOverride:
  | (() => Promise<XChatRawCryptoModuleLike>)
  | null = null;
let loadXChatJuiceboxSdkOverride:
  | (() => Promise<XChatJuiceboxSdkModuleLike>)
  | null = null;
let rawCryptoModulePromise: Promise<XChatRawCryptoModuleLike> | null = null;

export function __testOverrideXChatRuntime(
  params: {
    sdk?: (() => Promise<XChatSdkModuleLike>) | null;
    xdk?: (() => Promise<XChatXdkModuleLike>) | null;
    cryptoSdk?: (() => Promise<XChatCryptoSdkModuleLike>) | null;
    rawCrypto?: (() => Promise<XChatRawCryptoModuleLike>) | null;
    juiceboxSdk?: (() => Promise<XChatJuiceboxSdkModuleLike>) | null;
  } | null,
): void {
  loadXChatSdkOverride = params?.sdk ?? null;
  loadXChatXdkOverride = params?.xdk ?? null;
  loadXChatCryptoSdkOverride = params?.cryptoSdk ?? null;
  loadXChatRawCryptoOverride = params?.rawCrypto ?? null;
  loadXChatJuiceboxSdkOverride = params?.juiceboxSdk ?? null;
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

export async function loadXChatCryptoSdkModule(): Promise<XChatCryptoSdkModuleLike> {
  if (loadXChatCryptoSdkOverride) return loadXChatCryptoSdkOverride();
  return loadChannelRuntimeModule<XChatCryptoSdkModuleLike>(
    "xchat",
    "@xdevplatform/chat-xdk",
  );
}

function findXChatRuntimePackageFile(
  packageName: string,
  relativePath: string,
): string {
  const packageSegments = packageName.split("/");
  for (const runtimeDir of getChannelRuntimeSearchPaths("xchat")) {
    const candidate = join(
      runtimeDir,
      "node_modules",
      ...packageSegments,
      ...relativePath.split("/"),
    );
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `The X Chat runtime is missing ${packageName}/${relativePath}. Run letta channels install xchat.`,
  );
}

/**
 * Load the pinned Chat XDK's raw WASM crypto engine. The public Juicebox
 * wrapper intentionally hides private-key export/import, but crash-safe bot
 * enrollment must checkpoint one generated identity before the rate-limited
 * public-key POST. The raw engine ships in the same pinned runtime package.
 */
export async function loadXChatRawCryptoModule(): Promise<XChatRawCryptoModuleLike> {
  if (loadXChatRawCryptoOverride) return loadXChatRawCryptoOverride();
  if (!rawCryptoModulePromise) {
    rawCryptoModulePromise = (async () => {
      if (typeof globalThis.crypto === "undefined") {
        const { webcrypto } = await import("node:crypto");
        Object.defineProperty(globalThis, "crypto", {
          configurable: true,
          value: webcrypto,
        });
      }
      const manifestPath = findXChatRuntimePackageFile(
        "@xdevplatform/chat-xdk",
        "package.json",
      );
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        version?: unknown;
      };
      if (manifest.version !== "0.5.0") {
        throw new Error(
          "Crash-safe X Chat registration is guarded for @xdevplatform/chat-xdk 0.5.0, " +
            `but the installed runtime contains ${String(manifest.version ?? "an unknown version")}. ` +
            "Update Letta Code before registering another key.",
        );
      }
      const packageRoot = dirname(manifestPath);
      const modulePath = join(packageRoot, "pkg", "chat_xdk_wasm.js");
      const wasmPath = join(packageRoot, "pkg", "chat_xdk_wasm_bg.wasm");
      if (!existsSync(modulePath) || !existsSync(wasmPath)) {
        throw new Error(
          "The pinned X Chat runtime is missing its WASM checkpoint files. " +
            "Run letta channels install xchat to repair it before registering a key.",
        );
      }
      const module = (await import(
        pathToFileURL(modulePath).href
      )) as XChatRawCryptoModuleLike;
      if (
        typeof module.default !== "function" ||
        typeof module.Chat !== "function" ||
        typeof module.Chat.prototype.generateKeypairs !== "function" ||
        typeof module.Chat.prototype.exportKeys !== "function" ||
        typeof module.Chat.prototype.importKeys !== "function" ||
        typeof module.Chat.prototype.verifyKeyBinding !== "function"
      ) {
        throw new Error(
          "The pinned X Chat crypto runtime does not expose the checkpoint API. " +
            "Refusing to publish a key without a recoverable private-key backup.",
        );
      }
      await module.default({ module_or_path: readFileSync(wasmPath) });
      return module;
    })().catch((error) => {
      rawCryptoModulePromise = null;
      throw error;
    });
  }
  return rawCryptoModulePromise;
}

/**
 * Load the Juicebox constructors after createChat() has initialized their WASM
 * module. Keeping this behind the runtime loader preserves the channel's
 * isolated dependency installation.
 */
export async function loadXChatJuiceboxSdkModule(): Promise<XChatJuiceboxSdkModuleLike> {
  if (loadXChatJuiceboxSdkOverride) return loadXChatJuiceboxSdkOverride();
  return loadChannelRuntimeModule<XChatJuiceboxSdkModuleLike>(
    "xchat",
    "juicebox-sdk/juicebox-sdk_bg.js",
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
