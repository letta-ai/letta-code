import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  clearChannelAccountStores,
  upsertChannelAccount,
} from "@/channels/accounts";
import { __testOverrideChannelsRoot } from "@/channels/config";
import { ChannelRegistry, getChannelRegistry } from "@/channels/registry";
import type { ChannelAdapter, ChannelTurnSource } from "@/channels/types";
import {
  createChannelRichDraftStreamer,
  extractChannelSendRichDraftIntent,
} from "./channel-rich-draft-streamer";

let channelRoot: string | null = null;

function telegramSource(
  overrides: Partial<ChannelTurnSource> = {},
): ChannelTurnSource {
  return {
    channel: "telegram",
    accountId: "acct-telegram",
    chatId: "chat-12345",
    chatType: "direct",
    messageId: "14280",
    threadId: null,
    agentId: "agent-1",
    conversationId: "default",
    ...overrides,
  };
}

function upsertTelegramAccount(
  richDraftStreaming: boolean,
  richPrivateChatDefault = true,
): void {
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
    richPrivateChatDefault,
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

describe("Telegram rich draft streamer", () => {
  beforeEach(() => {
    channelRoot = mkdtempSync(join(tmpdir(), "letta-telegram-rich-draft-"));
    __testOverrideChannelsRoot(channelRoot);
    clearChannelAccountStores();
  });

  afterEach(async () => {
    const registry = getChannelRegistry();
    if (registry) {
      await registry.stopAll();
    }
    clearChannelAccountStores();
    __testOverrideChannelsRoot(null);
    if (channelRoot) {
      rmSync(channelRoot, { recursive: true, force: true });
      channelRoot = null;
    }
  });

  test("stays disabled unless the Telegram account opts in", () => {
    upsertTelegramAccount(false);
    registerTelegramAdapter();

    const streamer = createChannelRichDraftStreamer({
      batchId: "batch-1",
      sources: [telegramSource()],
      debounceMs: 0,
    });

    expect(streamer).toBeNull();
  });

  test("streams partial MessageChannel send-rich args as a routed Telegram draft", async () => {
    upsertTelegramAccount(true);
    const { sendRichMessageDraft } = registerTelegramAdapter();

    const streamer = createChannelRichDraftStreamer({
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
            '{"action":"send-rich","channel":"telegram","chat_id":"telegram:chat-12345","accountId":"acct-telegram","message":"# Draft\\n\\nStill gener',
        },
      ],
    } as never);
    await streamer?.flushPending();

    expect(sendRichMessageDraft).toHaveBeenCalledTimes(1);
    expect(sendRichMessageDraft).toHaveBeenCalledWith({
      channel: "telegram",
      accountId: "acct-telegram",
      chatId: "chat-12345",
      threadId: "42",
      draftId: expect.any(Number),
      source: telegramSource({ threadId: "42" }),
      richMessage: { markdown: "# Draft\n\nStill gener" },
    });
  });

  test("streams private Telegram send args as default rich drafts", async () => {
    upsertTelegramAccount(true);
    const { sendRichMessageDraft } = registerTelegramAdapter();

    const streamer = createChannelRichDraftStreamer({
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
            '{"action":"send","channel":"telegram","chat_id":"telegram:chat-12345","accountId":"acct-telegram","message":"# Private default',
        },
      ],
    } as never);
    await streamer?.flushPending();

    expect(sendRichMessageDraft).toHaveBeenCalledTimes(1);
    expect(sendRichMessageDraft).toHaveBeenCalledWith({
      channel: "telegram",
      accountId: "acct-telegram",
      chatId: "chat-12345",
      threadId: null,
      draftId: expect.any(Number),
      source: telegramSource(),
      richMessage: { markdown: "# Private default" },
    });
  });

  test("disables rich drafts for multiple distinct source messages", () => {
    upsertTelegramAccount(true);
    const { sendRichMessageDraft } = registerTelegramAdapter();

    const streamer = createChannelRichDraftStreamer({
      batchId: "batch-multiple-messages",
      sources: [
        telegramSource({ messageId: "14280" }),
        telegramSource({ messageId: "14281" }),
      ],
      debounceMs: 0,
    });

    expect(streamer).toBeNull();
    expect(sendRichMessageDraft).not.toHaveBeenCalled();
  });

  test("disables rich drafts for conflicting source metadata", () => {
    upsertTelegramAccount(true);
    const { sendRichMessageDraft } = registerTelegramAdapter();

    const streamer = createChannelRichDraftStreamer({
      batchId: "batch-conflicting-source",
      sources: [
        telegramSource({ senderId: "sender-1" }),
        telegramSource({ senderId: "sender-2" }),
      ],
      debounceMs: 0,
    });

    expect(streamer).toBeNull();
    expect(sendRichMessageDraft).not.toHaveBeenCalled();
  });

  test("does not stream private Telegram send args when default rich messaging is disabled", async () => {
    upsertTelegramAccount(true, false);
    const { sendRichMessageDraft } = registerTelegramAdapter();

    const streamer = createChannelRichDraftStreamer({
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
            '{"action":"send","channel":"telegram","chat_id":"telegram:chat-12345","accountId":"acct-telegram","message":"# Private plain',
        },
      ],
    } as never);
    await streamer?.flushPending();

    expect(sendRichMessageDraft).not.toHaveBeenCalled();
  });

  test("does not stream plain send args from Telegram channel routes", async () => {
    upsertTelegramAccount(true);
    const { sendRichMessageDraft } = registerTelegramAdapter();

    const streamer = createChannelRichDraftStreamer({
      batchId: "batch-1",
      sources: [telegramSource({ chatType: "channel", threadId: "42" })],
      debounceMs: 0,
    });

    streamer?.handleChunk({
      message_type: "approval_request_message",
      tool_calls: [
        {
          tool_call_id: "call-1",
          name: "MessageChannel",
          arguments:
            '{"action":"send","channel":"telegram","chat_id":"telegram:chat-12345","accountId":"acct-telegram","threadId":"42","message":"# Channel plain',
        },
      ],
    } as never);
    await streamer?.flushPending();

    expect(sendRichMessageDraft).not.toHaveBeenCalled();
  });

  test("sends the first visible draft immediately even when updates are debounced", async () => {
    upsertTelegramAccount(true);
    const { sendRichMessageDraft } = registerTelegramAdapter();

    const streamer = createChannelRichDraftStreamer({
      batchId: "batch-1",
      sources: [telegramSource()],
      debounceMs: 750,
    });

    streamer?.handleChunk({
      message_type: "approval_request_message",
      tool_calls: [
        {
          tool_call_id: "call-1",
          name: "MessageChannel",
          arguments:
            '{"action":"send-rich","channel":"telegram","chat_id":"telegram:chat-12345","accountId":"acct-telegram","message":"# Fast',
        },
      ],
    } as never);

    await Promise.resolve();
    expect(sendRichMessageDraft).toHaveBeenCalledTimes(1);

    streamer?.handleChunk({
      message_type: "approval_request_message",
      tool_calls: [
        {
          tool_call_id: "call-1",
          arguments: " update",
        },
      ],
    } as never);

    await Promise.resolve();
    expect(sendRichMessageDraft).toHaveBeenCalledTimes(1);

    await streamer?.flushPending();
    expect(sendRichMessageDraft).toHaveBeenCalledTimes(2);
    const secondCallDraft = (
      sendRichMessageDraft.mock.calls[1] as unknown[] | undefined
    )?.[0];
    expect(secondCallDraft).toMatchObject({
      richMessage: { markdown: "# Fast update" },
    });
  });

  test("cancels pending trailing drafts once the tool call returns", async () => {
    upsertTelegramAccount(true);
    const { sendRichMessageDraft } = registerTelegramAdapter();

    const streamer = createChannelRichDraftStreamer({
      batchId: "batch-1",
      sources: [telegramSource()],
      debounceMs: 30,
    });

    streamer?.handleChunk({
      message_type: "approval_request_message",
      tool_calls: [
        {
          tool_call_id: "call-1",
          name: "MessageChannel",
          arguments:
            '{"action":"send-rich","channel":"telegram","chat_id":"telegram:chat-12345","accountId":"acct-telegram","message":"# First',
        },
      ],
    } as never);
    await Promise.resolve();
    expect(sendRichMessageDraft).toHaveBeenCalledTimes(1);

    streamer?.handleChunk({
      message_type: "approval_request_message",
      tool_calls: [
        {
          tool_call_id: "call-1",
          arguments: " trailing",
        },
      ],
    } as never);

    streamer?.handleChunk({
      message_type: "tool_return_message",
      tool_call_id: "call-1",
    } as never);

    await sleep(45);
    expect(sendRichMessageDraft).toHaveBeenCalledTimes(1);
  });

  test("ignores late fragments after a tool call returns while a draft is in flight", async () => {
    upsertTelegramAccount(true);
    const deferred = createDeferred();
    const sendRichMessageDraft = mock(async () => {
      await deferred.promise;
    });
    registerTelegramAdapter(sendRichMessageDraft);

    const streamer = createChannelRichDraftStreamer({
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
            '{"action":"send-rich","channel":"telegram","chat_id":"telegram:chat-12345","accountId":"acct-telegram","message":"# In flight',
        },
      ],
    } as never);
    await Promise.resolve();
    expect(sendRichMessageDraft).toHaveBeenCalledTimes(1);

    streamer?.handleChunk({
      message_type: "tool_return_message",
      tool_call_id: "call-1",
    } as never);
    streamer?.handleChunk({
      message_type: "approval_request_message",
      tool_calls: [
        {
          tool_call_id: "call-1",
          arguments: " stale",
        },
      ],
    } as never);

    deferred.resolve();
    await streamer?.flushPending();
    expect(sendRichMessageDraft).toHaveBeenCalledTimes(1);
  });

  test("keeps updating drafts during continuous chunk flow", async () => {
    upsertTelegramAccount(true);
    const { sendRichMessageDraft } = registerTelegramAdapter();

    const streamer = createChannelRichDraftStreamer({
      batchId: "batch-1",
      sources: [telegramSource()],
      debounceMs: 20,
    });

    streamer?.handleChunk({
      message_type: "approval_request_message",
      tool_calls: [
        {
          tool_call_id: "call-1",
          name: "MessageChannel",
          arguments:
            '{"action":"send-rich","channel":"telegram","chat_id":"telegram:chat-12345","accountId":"acct-telegram","message":"# Stream',
        },
      ],
    } as never);
    await Promise.resolve();
    expect(sendRichMessageDraft).toHaveBeenCalledTimes(1);

    for (let index = 0; index < 6; index += 1) {
      await sleep(5);
      streamer?.handleChunk({
        message_type: "approval_request_message",
        tool_calls: [
          {
            tool_call_id: "call-1",
            arguments: ` ${index}`,
          },
        ],
      } as never);
    }

    await sleep(8);
    expect(sendRichMessageDraft.mock.calls.length).toBeGreaterThanOrEqual(2);

    await streamer?.flushPending();
    const calls = sendRichMessageDraft.mock.calls as unknown[][];
    const lastCallDraft = calls.at(-1)?.[0] as
      | { richMessage?: { markdown?: string } }
      | undefined;
    expect(lastCallDraft?.richMessage?.markdown).toBe("# Stream 0 1 2 3 4 5");
  });

  test("honors Telegram retry_after before retrying draft updates", async () => {
    upsertTelegramAccount(true);
    let attempts = 0;
    const sendRichMessageDraft = mock(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw { parameters: { retry_after: 0.02 } };
      }
    });
    registerTelegramAdapter(sendRichMessageDraft);

    const streamer = createChannelRichDraftStreamer({
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
            '{"action":"send-rich","channel":"telegram","chat_id":"telegram:chat-12345","accountId":"acct-telegram","message":"# Retry me',
        },
      ],
    } as never);

    await sleep(5);
    expect(sendRichMessageDraft).toHaveBeenCalledTimes(1);

    await sleep(30);
    expect(sendRichMessageDraft).toHaveBeenCalledTimes(2);
    await streamer?.flushPending();
  });

  test("refuses drafts whose target route does not match the inbound source", async () => {
    upsertTelegramAccount(true);
    const { sendRichMessageDraft } = registerTelegramAdapter();
    const streamer = createChannelRichDraftStreamer({
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
    const streamer = createChannelRichDraftStreamer({
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
            '{"action":"send-rich","channel":"telegram","chat_id":"chat-12345","message":"# Failure is fine',
        },
      ],
    } as never);

    await expect(streamer?.flushPending()).resolves.toBeUndefined();
    expect(sendRichMessageDraft).toHaveBeenCalledTimes(1);
  });

  test("extracts partial JSON strings with real newlines", () => {
    const intent = extractChannelSendRichDraftIntent(
      '{"action":"send-rich","channel":"telegram","chat_id":"chat-12345","message":"# Title\\n\\n- item',
      telegramSource() as ChannelTurnSource & {
        channel: "telegram";
        accountId: string;
      },
    );

    expect(intent?.message).toBe("# Title\n\n- item");
  });
});
