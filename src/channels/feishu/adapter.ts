import { formatChannelLifecycleErrorMessage } from "@/channels/lifecycle-error";
import type {
  ChannelAdapter,
  ChannelTurnLifecycleEvent,
  FeishuChannelAccount,
  OutboundChannelMessage,
} from "@/channels/types";
import { FEISHU_BOT_INFO_PATH, parseFeishuBotInfo } from "./bot-info";
import { evaluateFeishuReceiveEvent } from "./ingress";
import type {
  LarkClientLike,
  LarkEventDispatcherLike,
  LarkRuntimeModuleLike,
  LarkWsClientLike,
} from "./internal-types";
import {
  buildFeishuCreateTextMessage,
  buildFeishuReplyTextMessage,
} from "./outbound";
import { loadFeishuModule, resolveFeishuSdkDomain } from "./runtime";

const INGRESS_DEDUPE_TTL_MS = 7 * 60 * 60 * 1000;
const INGRESS_DEDUPE_MAX = 10_000;

const runningFeishuAppIds = new Map<string, string>();

export function __testResetFeishuAppIdOwners(): void {
  runningFeishuAppIds.clear();
}

export interface CreateFeishuAdapterOptions {
  loadRuntimeModule?: () => Promise<LarkRuntimeModuleLike>;
}

function pruneSeenMessageIds(seen: Map<string, number>, now: number): void {
  if (seen.size <= INGRESS_DEDUPE_MAX) {
    for (const [id, seenAt] of seen) {
      if (now - seenAt > INGRESS_DEDUPE_TTL_MS) {
        seen.delete(id);
      }
    }
    return;
  }
  const entries = [...seen.entries()].sort((left, right) => left[1] - right[1]);
  const extra = seen.size - INGRESS_DEDUPE_MAX;
  for (let index = 0; index < extra; index += 1) {
    const id = entries[index]?.[0];
    if (id) seen.delete(id);
  }
}

function claimFeishuAppId(appId: string, accountId: string): void {
  const owner = runningFeishuAppIds.get(appId);
  if (owner && owner !== accountId) {
    throw new Error(
      `Feishu app ${appId} is already connected by account "${owner}". Only one listener can run per App ID — Feishu delivers each event to one connection in cluster mode.`,
    );
  }
  runningFeishuAppIds.set(appId, accountId);
}

function releaseFeishuAppId(appId: string, accountId: string): void {
  if (runningFeishuAppIds.get(appId) === accountId) {
    runningFeishuAppIds.delete(appId);
  }
}

async function resolveBotOpenId(api: LarkClientLike): Promise<string | null> {
  if (typeof api.request !== "function") {
    return null;
  }
  try {
    const result = await api.request({
      url: FEISHU_BOT_INFO_PATH,
      method: "GET",
    });
    return parseFeishuBotInfo(result).openId ?? null;
  } catch (error) {
    console.warn(
      "[Feishu] Could not resolve bot open_id from /open-apis/bot/v3/info:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

function readCreatedMessageId(result: unknown): string {
  if (
    result &&
    typeof result === "object" &&
    "data" in result &&
    result.data &&
    typeof result.data === "object" &&
    "message_id" in result.data &&
    typeof result.data.message_id === "string" &&
    result.data.message_id.trim()
  ) {
    return result.data.message_id;
  }
  return `feishu-${Date.now()}`;
}

export function createFeishuAdapter(
  config: FeishuChannelAccount,
  options?: CreateFeishuAdapterOptions,
): ChannelAdapter {
  let client: LarkClientLike | null = null;
  let wsClient: LarkWsClientLike | null = null;
  let running = false;
  let botOpenId: string | null = null;
  let adapter!: ChannelAdapter;
  const seenMessageIds = new Map<string, number>();
  const loadRuntime = options?.loadRuntimeModule ?? loadFeishuModule;

  async function sendText(
    chatId: string,
    text: string,
    options?: { replyToMessageId?: string; threadId?: string | null },
  ): Promise<string> {
    if (!client) {
      throw new Error("Feishu not started");
    }
    const replyTo = options?.replyToMessageId?.trim();
    if (replyTo && typeof client.im.v1.message.reply === "function") {
      const request = buildFeishuReplyTextMessage({
        messageId: replyTo,
        text,
        replyInThread: Boolean(options?.threadId),
      });
      const result = await client.im.v1.message.reply(request);
      return readCreatedMessageId(result);
    }
    const request = buildFeishuCreateTextMessage({
      receiveId: chatId,
      receiveIdType: "chat_id",
      text,
    });
    const result = await client.im.v1.message.create(request);
    return readCreatedMessageId(result);
  }

  async function handleReceiveEvent(data: unknown): Promise<void> {
    try {
      const decision = evaluateFeishuReceiveEvent(data, {
        accountId: config.accountId,
        groupMode: config.groupMode,
        botOpenId,
      });
      if (decision.action === "drop") {
        return;
      }
      const inbound = decision.inbound;
      const messageId = inbound.messageId?.trim();
      if (messageId) {
        const now = Date.now();
        pruneSeenMessageIds(seenMessageIds, now);
        if (seenMessageIds.has(messageId)) {
          return;
        }
        seenMessageIds.set(messageId, now);
      }
      if (!adapter.onMessage) {
        return;
      }
      void adapter.onMessage(inbound).catch((error) => {
        console.error(
          "[Feishu] Error handling inbound message:",
          error instanceof Error ? error.message : error,
        );
      });
    } catch (error) {
      console.error(
        "[Feishu] Failed to process receive event:",
        error instanceof Error ? error.message : error,
      );
    }
  }

  adapter = {
    id: `feishu:${config.accountId}`,
    channelId: "feishu",
    accountId: config.accountId,
    name: "Feishu / Lark",

    async start(): Promise<void> {
      if (running) return;

      const appId = config.appId.trim();
      const appSecret = config.appSecret.trim();
      if (!appId || !appSecret) {
        throw new Error(
          "Feishu account is missing an App ID or App Secret. Configure it first.",
        );
      }

      claimFeishuAppId(appId, config.accountId);

      try {
        const Lark = await loadRuntime();
        const domain = resolveFeishuSdkDomain(config.domain, Lark);
        const clientConfig = {
          appId,
          appSecret,
          domain,
          ...(Lark.AppType?.SelfBuild
            ? { appType: Lark.AppType.SelfBuild }
            : {}),
        };
        client = new Lark.Client(clientConfig);
        botOpenId = await resolveBotOpenId(client);
        if (!botOpenId) {
          console.warn(
            "[Feishu] Bot open_id is unknown; mention-only groups will drop @mentions until /open-apis/bot/v3/info succeeds.",
          );
        }
        wsClient = new Lark.WSClient(clientConfig);
        const dispatcher: LarkEventDispatcherLike = new Lark.EventDispatcher(
          {},
        ).register({
          "im.message.receive_v1": handleReceiveEvent,
        });

        running = true;
        const startResult = wsClient.start({ eventDispatcher: dispatcher });
        if (startResult && typeof startResult.then === "function") {
          void startResult.catch((error: unknown) => {
            running = false;
            releaseFeishuAppId(appId, config.accountId);
            client = null;
            wsClient = null;
            botOpenId = null;
            console.error(
              "[Feishu] WebSocket connection failed:",
              error instanceof Error ? error.message : error,
            );
          });
        }
        console.log(
          `[Feishu] Persistent connection started for ${appId} (${config.domain}, dm_policy: ${config.dmPolicy})`,
        );
      } catch (error) {
        running = false;
        releaseFeishuAppId(appId, config.accountId);
        client = null;
        wsClient = null;
        botOpenId = null;
        throw error;
      }
    },

    async stop(): Promise<void> {
      running = false;
      releaseFeishuAppId(config.appId.trim(), config.accountId);
      try {
        wsClient?.close?.();
      } catch (error) {
        console.warn(
          "[Feishu] Error while closing WebSocket:",
          error instanceof Error ? error.message : error,
        );
      }
      client = null;
      wsClient = null;
      botOpenId = null;
      seenMessageIds.clear();
      console.log("[Feishu] Bot stopped");
    },

    isRunning(): boolean {
      return running;
    },

    async handleTurnLifecycleEvent(
      event: ChannelTurnLifecycleEvent,
    ): Promise<void> {
      if (!running || event.type !== "finished" || event.outcome !== "error") {
        return;
      }
      const errorText = event.error?.trim();
      if (!errorText) return;
      const formatted = formatChannelLifecycleErrorMessage(errorText, {
        runId: event.runId,
      });
      const uniqueChats = new Map<string, string | undefined>();
      for (const source of event.sources) {
        if (!uniqueChats.has(source.chatId)) {
          uniqueChats.set(source.chatId, source.messageId);
        }
      }
      await Promise.all(
        [...uniqueChats.entries()].map(async ([chatId, messageId]) => {
          try {
            await sendText(chatId, formatted, {
              replyToMessageId: messageId,
              threadId: event.sources.find((source) => source.chatId === chatId)
                ?.threadId,
            });
          } catch (error) {
            console.warn(
              `[Feishu] Failed to post lifecycle error for ${chatId}:`,
              error instanceof Error ? error.message : error,
            );
          }
        }),
      );
    },

    async sendMessage(
      msg: OutboundChannelMessage,
    ): Promise<{ messageId: string }> {
      const messageId = await sendText(msg.chatId, msg.text, {
        replyToMessageId: msg.replyToMessageId,
        threadId: msg.threadId,
      });
      return { messageId };
    },

    async sendDirectReply(
      chatId: string,
      text: string,
      options?: { replyToMessageId?: string },
    ): Promise<void> {
      await sendText(chatId, text, {
        replyToMessageId: options?.replyToMessageId,
      });
    },
  };

  return adapter;
}
