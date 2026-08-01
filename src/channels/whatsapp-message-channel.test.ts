import { describe, expect, test } from "bun:test";
import type { ChannelMessageActionContext } from "@/channels/plugin-types";
import type { ChannelAdapter, OutboundChannelMessage } from "@/channels/types";
import { whatsappMessageActions } from "@/channels/whatsapp/message-actions";

function makeContext(action: string, overrides: Record<string, unknown> = {}) {
  const sent: OutboundChannelMessage[] = [];
  const adapter: ChannelAdapter = {
    id: "whatsapp:test",
    channelId: "whatsapp",
    accountId: "acct",
    name: "WhatsApp",
    async start() {},
    async stop() {},
    isRunning() {
      return true;
    },
    async sendMessage(msg) {
      sent.push(msg);
      return { messageId: "msg-1" };
    },
    async sendDirectReply() {},
  };
  const ctx: ChannelMessageActionContext = {
    request: {
      action,
      channel: "whatsapp",
      chatId: "15551234567@s.whatsapp.net",
      ...overrides,
    },
    route: {
      accountId: "acct",
      chatId: "15551234567@s.whatsapp.net",
      agentId: "agent-test",
      conversationId: "conv-test",
      enabled: true,
      createdAt: "2026-04-30T00:00:00.000Z",
    },
    adapter,
    formatText(text) {
      return { text };
    },
  };
  return { ctx, sent };
}

describe("WhatsApp MessageChannel actions", () => {
  test("advertises send, react, and upload-file", () => {
    expect(whatsappMessageActions.describeMessageTool({}).actions).toEqual([
      "send",
      "react",
      "upload-file",
    ]);
  });

  test("documents the Ogg/Opus requirement for media uploads", () => {
    expect(whatsappMessageActions.describeMessageTool({}).schema).toEqual({
      properties: {
        media: expect.objectContaining({
          description: expect.stringContaining("Ogg/Opus"),
        }),
      },
    });
  });

  test("sends text messages", async () => {
    const { ctx, sent } = makeContext("send", { message: "hello" });
    await expect(whatsappMessageActions.handleAction(ctx)).resolves.toContain(
      "Message sent",
    );
    expect(sent[0]).toEqual(
      expect.objectContaining({
        channel: "whatsapp",
        accountId: "acct",
        chatId: "15551234567@s.whatsapp.net",
        text: "hello",
      }),
    );
  });

  test("validates upload-file media path", async () => {
    const { ctx } = makeContext("upload-file");
    await expect(whatsappMessageActions.handleAction(ctx)).resolves.toMatch(
      /requires media/,
    );
  });

  test("forwards MP3 audio uploads to the adapter as documents", async () => {
    const { ctx, sent } = makeContext("upload-file", {
      mediaPath: "/tmp/voice.mp3",
    });

    await expect(whatsappMessageActions.handleAction(ctx)).resolves.toContain(
      "Attachment sent",
    );
    expect(sent[0]).toEqual(
      expect.objectContaining({
        channel: "whatsapp",
        mediaPath: "/tmp/voice.mp3",
      }),
    );
  });

  test("sends reactions", async () => {
    const { ctx, sent } = makeContext("react", {
      emoji: "👍",
      messageId: "target-msg",
    });
    await expect(whatsappMessageActions.handleAction(ctx)).resolves.toContain(
      "Reaction added",
    );
    expect(sent[0]).toEqual(
      expect.objectContaining({
        reaction: "👍",
        targetMessageId: "target-msg",
      }),
    );
  });
});
