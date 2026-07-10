import type SlackApp from "@slack/bolt";
import { formatChannelControlRequestPrompt } from "@/channels/interactive";
import { buildSlackModelPickerBlocks } from "@/channels/slack/model-picker-blocks";
import type {
  ChannelAdapter,
  ChannelControlRequestEvent,
  ChannelModelPickerData,
  ChannelTurnLifecycleEvent,
  ChannelTurnProgressEvent,
  ChannelTurnSource,
  OutboundChannelMessage,
  SlackChannelAccount,
} from "@/channels/types";
import { trackBoundaryError } from "@/telemetry/error-reporting";
import {
  type AgentThreadTracker,
  createAgentThreadTracker,
} from "./agent-thread-tracker";
import { createSlackApprovalController } from "./approval-controller";
import { uploadSlackFile } from "./file-upload";
import {
  createSlackInboundDebounceController,
  type SlackInboundDebounceController,
} from "./inbound-debounce";
import { createSlackIngressController } from "./ingress-controller";
import type { SlackWriteClient } from "./internal-types";
import {
  buildSlackChatFootnote,
  buildSlackReplyBlocksWithFootnote,
  formatSlackControlRequestBlocks,
  formatSlackLifecycleErrorMessage,
  resolveSlackConcreteActivity,
  SLACK_ASSISTANT_STARTUP_STATUS,
  SLACK_ASSISTANT_WORKING_STATUS,
  shouldPostSlackTerminalError,
} from "./presentation";
import { loadSlackBoltModule } from "./runtime";
import { createSlackStatusController } from "./status-controller";
import { prepareSlackInboundMessage } from "./thread-context";
import {
  asSlackBlocks,
  isNonEmptyString,
  isSlackFlatChannelThreadOpener,
  normalizeSlackReactionName,
  resolveSlackAppConstructor,
  resolveSlackChatType,
  resolveSlackOutboundThreadTs,
  resolveSlackSourceThreadTs,
} from "./utils";
import { createSlackWebApiClient } from "./web-api-client";

export function createSlackAdapter(
  config: SlackChannelAccount,
): ChannelAdapter {
  let app: SlackApp | null = null;
  let writeClient: SlackWriteClient | null = null;
  let writeClientPromise: Promise<SlackWriteClient> | null = null;
  let running = false;
  let botUserId: string | null = null;
  let adapter: ChannelAdapter;

  const agentThreadTracker: AgentThreadTracker = createAgentThreadTracker();
  const debounce: SlackInboundDebounceController =
    createSlackInboundDebounceController({
      config,
      getOnMessage: () => adapter.onMessage,
    });
  const ingress = createSlackIngressController({
    config,
    getAdapter: () => adapter,
    getBotUserId: () => botUserId,
    agentThreadTracker,
    debounce,
  });
  const status = createSlackStatusController({
    ensureApp,
    ensureWriteClient,
    resolveKnownThreadRoot: ingress.resolveKnownThreadRoot,
  });
  const approvals = createSlackApprovalController({
    config,
    getAdapter: () => adapter,
    ensureWriteClient,
  });

  async function ensureApp(): Promise<SlackApp> {
    if (app) return app;
    const bolt = await loadSlackBoltModule();
    const App = resolveSlackAppConstructor(bolt);
    const instance = new App({
      token: config.botToken,
      appToken: config.appToken,
      socketMode: true,
    });
    instance.error(async (error) => {
      console.error("[Slack] Unhandled app error:", error);
    });
    ingress.register(instance);
    approvals.register(instance);
    app = instance;
    return instance;
  }

  async function ensureWriteClient(): Promise<SlackWriteClient> {
    if (writeClient) return writeClient;
    writeClientPromise ??= createSlackWebApiClient<SlackWriteClient>(
      config.botToken,
      { retryConfig: { retries: 0 } },
    ).then((client) => {
      writeClient = client;
      return client;
    });
    try {
      return await writeClientPromise;
    } catch (error) {
      writeClientPromise = null;
      throw error;
    }
  }

  async function sendLifecycleErrorReply(
    source: ChannelTurnSource,
    errorText: string,
  ): Promise<void> {
    const threadTs = resolveSlackSourceThreadTs(source);
    const text = formatSlackLifecycleErrorMessage(errorText);
    const footnote = buildSlackChatFootnote(source);
    const blocks = footnote
      ? buildSlackReplyBlocksWithFootnote(text, footnote)
      : undefined;
    await ensureApp();
    const client = await ensureWriteClient();
    const response = await client.chat.postMessage({
      channel: source.chatId,
      text,
      ...(blocks ? { blocks } : {}),
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });
    ingress.rememberMessageThread(response.ts, threadTs ?? null);
  }

  async function handleTurnLifecycleEvent(
    event: ChannelTurnLifecycleEvent,
  ): Promise<void> {
    if (!running) return;
    if (event.type === "queued") {
      if (
        isSlackFlatChannelThreadOpener(event.source) &&
        isNonEmptyString(event.source.messageId) &&
        !agentThreadTracker.has(event.source.chatId, event.source.messageId)
      ) {
        await status.activate(
          event.source,
          SLACK_ASSISTANT_STARTUP_STATUS,
          SLACK_ASSISTANT_STARTUP_STATUS,
        );
      }
      return;
    }

    const sources = status.getUniqueSources(event.sources);
    if (event.type === "processing") {
      await Promise.all(sources.map(status.clearStale));
      return;
    }
    if (event.stopReason === "requires_approval") return;

    await Promise.all(sources.map(status.deactivate));
    if (!shouldPostSlackTerminalError(event.stopReason)) return;
    const errorText = event.error?.trim() ?? "";
    trackBoundaryError({
      context: "slack channel turn",
      errorType: "slack_channel_turn_error",
      error: errorText || event.stopReason,
      runId: event.runId ?? undefined,
    });
    const uniqueReplySources = new Map<string, ChannelTurnSource>();
    for (const source of sources) {
      const key = status.getLifecycleErrorReplyKey(source);
      if (key && !uniqueReplySources.has(key)) {
        uniqueReplySources.set(key, source);
      }
    }
    await Promise.all(
      Array.from(uniqueReplySources.values()).map(async (source) => {
        try {
          await sendLifecycleErrorReply(source, errorText);
        } catch (error) {
          console.warn(
            `[Slack] Failed to post lifecycle error for ${source.chatId}:`,
            error instanceof Error ? error.message : error,
          );
        }
      }),
    );
  }

  async function sendMessage(
    msg: OutboundChannelMessage,
  ): Promise<{ messageId: string }> {
    await ensureApp();
    const client = await ensureWriteClient();
    if (msg.reaction) {
      const targetMessageId = msg.targetMessageId ?? msg.replyToMessageId;
      if (!targetMessageId) {
        throw new Error(
          "Slack reactions require message_id (or reply_to_message_id) to identify the target message.",
        );
      }
      const emoji = normalizeSlackReactionName(msg.reaction);
      if (!emoji) throw new Error("Slack reaction emoji cannot be empty.");
      const reactionArgs = {
        channel: msg.chatId,
        timestamp: targetMessageId,
        name: emoji,
      };
      if (msg.removeReaction) await client.reactions.remove(reactionArgs);
      else await client.reactions.add(reactionArgs);
      return { messageId: targetMessageId };
    }

    if (msg.mediaPath) {
      const result = await uploadSlackFile(client, msg);
      const threadId = msg.threadId ?? msg.replyToMessageId ?? null;
      if (
        resolveSlackChatType(msg.chatId) === "channel" &&
        isNonEmptyString(threadId)
      ) {
        agentThreadTracker.remember(msg.chatId, threadId);
      }
      status.markAutoClearedForMessage(msg);
      return result;
    }

    const threadTs = resolveSlackOutboundThreadTs({
      chatId: msg.chatId,
      threadId: msg.threadId,
      replyToMessageId: msg.replyToMessageId,
    });
    const footnote =
      isNonEmptyString(msg.agentId) && isNonEmptyString(msg.conversationId)
        ? buildSlackChatFootnote({
            agentId: msg.agentId,
            conversationId: msg.conversationId,
          })
        : "";
    const blocks = footnote
      ? buildSlackReplyBlocksWithFootnote(msg.text, footnote)
      : undefined;
    const response = await client.chat.postMessage({
      channel: msg.chatId,
      text: msg.text,
      ...(blocks ? { blocks } : {}),
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });
    const outboundThreadId =
      threadTs ??
      (resolveSlackChatType(msg.chatId) === "channel"
        ? (response.ts ?? null)
        : null);
    ingress.rememberMessageThread(response.ts, outboundThreadId);
    if (
      resolveSlackChatType(msg.chatId) === "channel" &&
      isNonEmptyString(outboundThreadId)
    ) {
      agentThreadTracker.remember(msg.chatId, outboundThreadId);
    }
    status.markAutoClearedForMessage(msg);
    return { messageId: response.ts ?? "" };
  }

  async function sendDirectReply(
    chatId: string,
    text: string,
    options?: {
      replyToMessageId?: string;
      threadId?: string | null;
      modelPicker?: ChannelModelPickerData;
    },
  ): Promise<void> {
    await ensureApp();
    const client = await ensureWriteClient();
    const threadTs = resolveSlackOutboundThreadTs({
      chatId,
      threadId: options?.threadId,
      replyToMessageId: options?.replyToMessageId,
    });
    const pickerBlocks = options?.modelPicker
      ? buildSlackModelPickerBlocks(options.modelPicker)
      : undefined;
    const response = await client.chat.postMessage({
      channel: chatId,
      text,
      ...(pickerBlocks ? { blocks: asSlackBlocks(pickerBlocks) } : {}),
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });
    const outboundThreadId =
      threadTs ??
      (resolveSlackChatType(chatId) === "channel"
        ? (response.ts ?? null)
        : null);
    ingress.rememberMessageThread(response.ts, outboundThreadId);
    if (
      resolveSlackChatType(chatId) === "channel" &&
      isNonEmptyString(outboundThreadId)
    ) {
      agentThreadTracker.remember(chatId, outboundThreadId);
    }
    status.markAutoClearedForMessage({
      chatId,
      threadId: options?.threadId ?? null,
      replyToMessageId: options?.replyToMessageId,
    });
  }

  async function handleControlRequestEvent(
    event: ChannelControlRequestEvent,
  ): Promise<void> {
    await ensureApp();
    const client = await ensureWriteClient();
    const text = formatChannelControlRequestPrompt(event);
    const blocks = formatSlackControlRequestBlocks(event);
    const threadTs = resolveSlackSourceThreadTs(event.source);
    const response = await client.chat.postMessage({
      channel: event.source.chatId,
      text,
      ...(blocks ? { blocks } : {}),
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });
    const outboundThreadId =
      threadTs ??
      (resolveSlackChatType(event.source.chatId) === "channel"
        ? (response.ts ?? null)
        : null);
    ingress.rememberMessageThread(response.ts, outboundThreadId);
    if (event.kind === "generic_tool_approval" && response.ts) {
      approvals.rememberPrompt(event, response.ts);
    }
    if (
      resolveSlackChatType(event.source.chatId) === "channel" &&
      isNonEmptyString(outboundThreadId)
    ) {
      agentThreadTracker.remember(event.source.chatId, outboundThreadId);
    }
    status.markAutoCleared(event.source);
  }

  adapter = {
    id: `slack:${config.accountId}`,
    channelId: "slack",
    accountId: config.accountId,
    name: "Slack",
    async start(): Promise<void> {
      if (running) return;
      const slackApp = await ensureApp();
      const auth = await slackApp.client.auth.test();
      botUserId = isNonEmptyString(auth.user_id) ? auth.user_id : null;
      await slackApp.start();
      running = true;
      console.log(
        `[Slack] App started for workspace ${auth.team ?? "unknown"} (dm_policy: ${config.dmPolicy})`,
      );
    },
    async stop(): Promise<void> {
      if (!app || !running) return;
      await Promise.all(
        status.getUniqueSources(status.activeSources()).map(status.deactivate),
      );
      await app.stop();
      running = false;
      app = null;
      writeClient = null;
      writeClientPromise = null;
      botUserId = null;
      status.clear();
      approvals.clear();
      debounce.clear();
      ingress.clear();
      agentThreadTracker.clear();
      console.log("[Slack] App stopped");
    },
    isRunning: () => running,
    handleTurnLifecycleEvent,
    async handleTurnProgressEvent(
      event: ChannelTurnProgressEvent,
    ): Promise<void> {
      if (!running) return;
      const activity = resolveSlackConcreteActivity(event);
      if (!activity) return;
      await Promise.all(
        status
          .getUniqueSources(event.sources)
          .map((source) =>
            status.activate(source, SLACK_ASSISTANT_WORKING_STATUS, activity),
          ),
      );
    },
    sendMessage,
    sendDirectReply,
    handleControlRequestEvent,
    prepareInboundMessage: (msg, options) =>
      prepareSlackInboundMessage({
        msg,
        options,
        config,
        ensureApp,
        resolveUserName: ingress.resolveUserName,
        getKnownUserDisplayName: ingress.getKnownUserDisplayName,
      }),
    onMessage: undefined,
    onControlResponse: undefined,
  };
  return adapter;
}
