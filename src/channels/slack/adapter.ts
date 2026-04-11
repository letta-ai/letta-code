import type SlackApp from "@slack/bolt";
import type {
  ChannelAdapter,
  InboundChannelMessage,
  OutboundChannelMessage,
  SlackChannelConfig,
} from "../types";
import { loadSlackBoltModule } from "./runtime";

type SlackBoltModule = typeof import("@slack/bolt");
type SlackAppConstructor = SlackBoltModule["default"];

function resolveSlackAppConstructor(mod: SlackBoltModule): SlackAppConstructor {
  const App = mod.default;
  if (!App) {
    throw new Error('Installed Slack runtime did not export default "App".');
  }
  return App;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeSlackText(text: string): string {
  return text.replace(/^(?:\s*<@[A-Z0-9]+>\s*)+/, "").trim();
}

function slackTimestampToMillis(timestamp: string): number {
  return Math.round(Number.parseFloat(timestamp) * 1000);
}

export function createSlackAdapter(config: SlackChannelConfig): ChannelAdapter {
  let app: SlackApp | null = null;
  let running = false;

  async function ensureApp(): Promise<SlackApp> {
    if (app) {
      return app;
    }

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

    instance.message(async ({ message }) => {
      if (!adapter.onMessage) {
        return;
      }

      const rawMessage = asRecord(message);
      if (!rawMessage) {
        return;
      }

      const channelId = rawMessage.channel;
      if (!isNonEmptyString(channelId) || !channelId.startsWith("D")) {
        return;
      }

      if (
        isNonEmptyString(rawMessage.subtype) ||
        isNonEmptyString(rawMessage.bot_id) ||
        !isNonEmptyString(rawMessage.user) ||
        !isNonEmptyString(rawMessage.ts)
      ) {
        return;
      }

      const text = isNonEmptyString(rawMessage.text) ? rawMessage.text : "";
      const inbound: InboundChannelMessage = {
        channel: "slack",
        chatId: channelId,
        senderId: rawMessage.user,
        senderName: rawMessage.user,
        text,
        timestamp: slackTimestampToMillis(rawMessage.ts),
        messageId: rawMessage.ts,
        chatType: "direct",
        raw: message,
      };

      try {
        await adapter.onMessage(inbound);
      } catch (error) {
        console.error("[Slack] Error handling DM message:", error);
      }
    });

    instance.event("app_mention", async ({ event }) => {
      if (!adapter.onMessage) {
        return;
      }

      if (
        !isNonEmptyString(event.channel) ||
        !isNonEmptyString(event.user) ||
        !isNonEmptyString(event.ts)
      ) {
        return;
      }

      const inbound: InboundChannelMessage = {
        channel: "slack",
        chatId: event.channel,
        senderId: event.user,
        senderName: event.user,
        text: normalizeSlackText(event.text ?? ""),
        timestamp: slackTimestampToMillis(event.ts),
        messageId: event.thread_ts ?? event.ts,
        chatType: "channel",
        raw: event,
      };

      try {
        await adapter.onMessage(inbound);
      } catch (error) {
        console.error("[Slack] Error handling channel mention:", error);
      }
    });

    app = instance;
    return instance;
  }

  const adapter: ChannelAdapter = {
    id: "slack",
    name: "Slack",

    async start(): Promise<void> {
      if (running) {
        return;
      }

      const slackApp = await ensureApp();
      await slackApp.init();
      const auth = await slackApp.client.auth.test();
      await slackApp.start();
      running = true;

      console.log(
        `[Slack] App started for workspace ${auth.team ?? "unknown"} (dm_policy: ${config.dmPolicy})`,
      );
    },

    async stop(): Promise<void> {
      if (!app || !running) {
        return;
      }
      await app.stop();
      running = false;
      app = null;
      console.log("[Slack] App stopped");
    },

    isRunning(): boolean {
      return running;
    },

    async sendMessage(
      msg: OutboundChannelMessage,
    ): Promise<{ messageId: string }> {
      const slackApp = await ensureApp();
      const response = await slackApp.client.chat.postMessage({
        channel: msg.chatId,
        text: msg.text,
        ...(msg.replyToMessageId ? { thread_ts: msg.replyToMessageId } : {}),
      });

      return { messageId: response.ts ?? "" };
    },

    async sendDirectReply(
      chatId: string,
      text: string,
      options?: { replyToMessageId?: string },
    ): Promise<void> {
      const slackApp = await ensureApp();
      await slackApp.client.chat.postMessage({
        channel: chatId,
        text,
        ...(options?.replyToMessageId
          ? { thread_ts: options.replyToMessageId }
          : {}),
      });
    },

    onMessage: undefined,
  };

  return adapter;
}
