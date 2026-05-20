import { randomUUID } from "node:crypto";
import type {
  ChannelAdapter,
  CustomChannelAccount,
  OutboundChannelMessage,
} from "@/channels/types";

/**
 * Outbound-only adapter for the first-party "custom" channel.
 *
 * `start()` / `stop()` toggle a local `running` flag — there is no inbound
 * listener in this MVP. The agent's outbound messages are forwarded as JSON
 * POSTs to the configured webhook URL.
 */
function readString(account: CustomChannelAccount, key: string): string | null {
  const value = account.config[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

interface CustomWebhookResponse {
  message_id?: unknown;
}

function extractMessageId(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = (value as CustomWebhookResponse).message_id;
  if (typeof candidate === "string" && candidate.length > 0) {
    return candidate;
  }
  if (typeof candidate === "number" && Number.isFinite(candidate)) {
    return String(candidate);
  }
  return null;
}

export function createCustomAdapter(
  account: CustomChannelAccount,
): ChannelAdapter {
  let running = false;

  async function deliver(
    msg: OutboundChannelMessage,
  ): Promise<{ messageId: string }> {
    const url = readString(account, "url");
    if (!url) {
      throw new Error(
        `Custom channel account ${account.accountId} is missing a webhook URL.`,
      );
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    const botToken = readString(account, "bot_token");
    if (botToken) {
      headers.Authorization = `Bearer ${botToken}`;
    }
    const auth = readString(account, "auth");
    if (auth) {
      headers["X-Letta-Auth"] = auth;
    }

    const body = JSON.stringify({
      channel: "custom",
      account_id: msg.accountId ?? account.accountId,
      chat_id: msg.chatId,
      text: msg.text,
      reply_to_message_id: msg.replyToMessageId,
      thread_id: msg.threadId ?? null,
      parse_mode: msg.parseMode,
      media_path: msg.mediaPath,
      file_name: msg.fileName,
      title: msg.title,
    });

    const response = await fetch(url, {
      method: "POST",
      headers,
      body,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `Custom webhook ${url} returned ${response.status}${text ? `: ${text}` : ""}`,
      );
    }

    let parsed: unknown = null;
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.toLowerCase().includes("application/json")) {
      try {
        parsed = await response.json();
      } catch {
        parsed = null;
      }
    }

    return { messageId: extractMessageId(parsed) ?? randomUUID() };
  }

  return {
    id: `custom:${account.accountId}`,
    channelId: "custom",
    accountId: account.accountId,
    name: account.displayName ?? "Custom",

    async start() {
      running = true;
    },

    async stop() {
      running = false;
    },

    isRunning() {
      return running;
    },

    async sendMessage(msg) {
      return deliver(msg);
    },

    async sendDirectReply(chatId, text, options) {
      await deliver({
        channel: "custom",
        accountId: account.accountId,
        chatId,
        text,
        replyToMessageId: options?.replyToMessageId,
      });
    },
  };
}
