import { afterEach, describe, expect, mock, test } from "bun:test";

import {
  clearChannelAccountStores,
  upsertChannelAccount,
} from "@/channels/accounts";
import { ChannelRegistry, getChannelRegistry } from "@/channels/registry";
import type { ChannelAdapter, ChannelTurnSource } from "@/channels/types";
import {
  createTelegramRichDraftStreamer,
  extractTelegramSendRichDraftIntent,
} from "./channel-rich-draft-streamer";

function telegramSource(
  overrides: Partial<ChannelTurnSource> = {},
): ChannelTurnSource {
  return {
    channel: "telegram",
    accountId: "acct-telegram",
    chatId: "515978553",
    chatType: "direct",
    messageId: "14280",
    threadId: null,
    agentId: "agent-1",
    conversationId: "default",
    ...overrides,
  };
}

function upsertTelegramAccount(richDraftStreaming: boolean): void {
  upsertChannelAccount("telegram", {
    channel: "telegram",
    accountId: "acct-telegram",
    displayName: "Telegram test",
    enabled: true,
    token: "test-token",
    dmPolicy: "pairing",
    allowedUsers: [],
    binding: {
      agentId: null,
      conversationId: null,
    },
    groupMode: "open",
    transcribeVoice: false,
    richDraftStreaming,
    createdAt: "2026-06-11T00:00:00.000Z",
    updatedAt: "2026-06-11T00:00:00.000Z",
  });
}

function registerTelegramAdapter(sendRichMessageDraft = mock(async () => {})) {
  const registry = new ChannelRegistry();
  const adapter: ChannelAdapter = {
    id: "telegram:acct-telegram",
    channelId: "telegram",
    accountId: "acct-telegram",
    name: "Telegram",
    start: async () => {},
    stop: async () => {},
    isRunning: () => true,
    sendMessage: async () => ({ messageId: "final" }),
    sendRichMessageDraft,
    sendDirectReply: async () => {},
  };
  registry.registerAdapter(adapter);
  return { adapter, sendRichMessageDraft };
}

describe("Telegram rich draft streamer", () => {
  afterEach(async () => {
    const registry = getChannelRegistry();
    if (registry) {
      await registry.stopAll();
    }
    clearChannelAccountStores();
  });

  test("stays disabled unless the Telegram account opts in", () => {
    upsertTelegramAccount(false);
    registerTelegramAdapter();

    const streamer = createTelegramRichDraftStreamer({
      batchId: "batch-1",
      sources: [telegramSource()],
      debounceMs: 0,
    });

    expect(streamer).toBeNull();
  });

  test("streams partial MessageChannel send-rich args as a routed Telegram draft", async () => {
    upsertTelegramAccount(true);
    const { sendRichMessageDraft } = registerTelegramAdapter();

    const streamer = createTelegramRichDraftStreamer({
      batchId: "batch-1",
      sources: [telegramSource({ threadId: "42" })],
      debounceMs: 0,
    });

    expect(streamer).not.toBeNull();
    streamer?.handleChunk({
      message_type: "approval_request_message",
      tool_calls: [
        {
          tool_call_id: "call-1",
          name: "MessageChannel",
          arguments:
            '{"action":"send-rich","channel":"telegram","chat_id":"telegram:515978553","accountId":"acct-telegram","message":"# Draft\\n\\nStill gener',
        },
      ],
    } as never);
    await streamer?.flushPending();

    expect(sendRichMessageDraft).toHaveBeenCalledTimes(1);
    expect(sendRichMessageDraft).toHaveBeenCalledWith({
      channel: "telegram",
      accountId: "acct-telegram",
      chatId: "515978553",
      threadId: "42",
      draftId: expect.any(Number),
      richMessage: { markdown: "# Draft\n\nStill gener" },
    });
  });

  test("refuses drafts whose target route does not match the inbound source", async () => {
    upsertTelegramAccount(true);
    const { sendRichMessageDraft } = registerTelegramAdapter();
    const streamer = createTelegramRichDraftStreamer({
      batchId: "batch-1",
      sources: [telegramSource()],
      debounceMs: 0,
    });

    streamer?.handleChunk({
      message_type: "approval_request_message",
      tool_calls: [
        {
          tool_call_id: "call-1",
          name: "MessageChannel",
          arguments:
            '{"action":"send-rich","channel":"telegram","chat_id":"999","message":"# Wrong chat',
        },
      ],
    } as never);
    await streamer?.flushPending();

    expect(sendRichMessageDraft).not.toHaveBeenCalled();
  });

  test("swallows draft send failures", async () => {
    upsertTelegramAccount(true);
    const sendRichMessageDraft = mock(async () => {
      throw new Error("draft endpoint unavailable");
    });
    registerTelegramAdapter(sendRichMessageDraft);
    const streamer = createTelegramRichDraftStreamer({
      batchId: "batch-1",
      sources: [telegramSource()],
      debounceMs: 0,
    });

    streamer?.handleChunk({
      message_type: "approval_request_message",
      tool_calls: [
        {
          tool_call_id: "call-1",
          name: "MessageChannel",
          arguments:
            '{"action":"send-rich","channel":"telegram","chat_id":"515978553","message":"# Failure is fine',
        },
      ],
    } as never);

    await expect(streamer?.flushPending()).resolves.toBeUndefined();
    expect(sendRichMessageDraft).toHaveBeenCalledTimes(1);
  });

  test("extracts partial JSON strings with real newlines", () => {
    const intent = extractTelegramSendRichDraftIntent(
      '{"action":"send-rich","channel":"telegram","chat_id":"515978553","message":"# Title\\n\\n- item',
      telegramSource() as ChannelTurnSource & {
        channel: "telegram";
        accountId: string;
      },
    );

    expect(intent?.message).toBe("# Title\n\n- item");
  });
});
