import { describe, expect, mock, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __testOverrideChannelsRoot } from "@/channels/config";
import type { SignalChannelAccount } from "@/channels/types";
import { formatChannelNotification } from "@/channels/xml";
import { createSignalAdapter } from "./adapter";
import { signalInboundFromSseEvent } from "./inbound";
import type { SignalClientLike } from "./internal-types";
import { __testOverrideSignalAttachmentSearchDirs } from "./media";

function signalAccount(
  overrides: Partial<SignalChannelAccount> = {},
): SignalChannelAccount {
  return {
    channel: "signal",
    accountId: "personal",
    displayName: "Signal",
    enabled: true,
    dmPolicy: "pairing",
    allowedUsers: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    baseUrl: "http://127.0.0.1:8080",
    account: "+15555550100",
    accountUuid: "self-uuid",
    agentId: "agent-signal",
    selfChatMode: false,
    groupMode: "disabled",
    ...overrides,
  };
}

function receiveEvent(data: unknown) {
  return {
    event: "receive",
    data: JSON.stringify(data),
  };
}

describe("signalInboundFromSseEvent", () => {
  test("filters own and sync messages", () => {
    expect(
      signalInboundFromSseEvent(
        receiveEvent({
          envelope: {
            sourceNumber: "+15555550100",
            dataMessage: { message: "own" },
          },
        }),
        signalAccount(),
      ),
    ).toBeNull();

    expect(
      signalInboundFromSseEvent(
        receiveEvent({
          envelope: { sourceNumber: "+15555550123", syncMessage: {} },
        }),
        signalAccount(),
      ),
    ).toBeNull();
  });

  test("routes own direct messages in self-chat mode", () => {
    const msg = signalInboundFromSseEvent(
      receiveEvent({
        envelope: {
          sourceNumber: "+15555550100",
          sourceName: "Cameron",
          timestamp: 123,
          dataMessage: { message: "note to self" },
        },
      }),
      signalAccount({ selfChatMode: true }),
    );

    expect(msg).toMatchObject({
      chatId: "signal:+15555550100",
      senderId: "+15555550100",
      text: "note to self",
    });
  });

  test("routes own sync sent messages in self-chat mode", () => {
    const msg = signalInboundFromSseEvent(
      receiveEvent({
        envelope: {
          sourceNumber: "+15555550100",
          timestamp: 123,
          syncMessage: {
            sentMessage: {
              destination: "+15555550100",
              timestamp: 124,
              message: "sync note",
            },
          },
        },
      }),
      signalAccount({ selfChatMode: true }),
    );

    expect(msg).toMatchObject({
      chatId: "signal:+15555550100",
      senderName: "Note to Self",
      text: "sync note",
    });
  });

  test("drops events for other signal accounts", () => {
    expect(
      signalInboundFromSseEvent(
        receiveEvent({
          account: "+15555550999",
          envelope: {
            sourceNumber: "+15555550123",
            timestamp: 123,
            dataMessage: { message: "wrong account" },
          },
        }),
        signalAccount({ account: "+15555550100" }),
      ),
    ).toBeNull();
  });

  test("drops non-self direct messages in self-chat mode", () => {
    expect(
      signalInboundFromSseEvent(
        receiveEvent({
          envelope: {
            sourceNumber: "+15555550123",
            timestamp: 123,
            dataMessage: { message: "hello" },
          },
        }),
        signalAccount({ selfChatMode: true }),
      ),
    ).toBeNull();
  });

  test("uses recipient alias for UUID-only direct reply targets", () => {
    const msg = signalInboundFromSseEvent(
      receiveEvent({
        envelope: {
          sourceUuid: "accd2cf3-8cb5-49c2-8904-5c4ce428c772",
          sourceName: "Cameron",
          timestamp: 123,
          dataMessage: { message: "please reply" },
        },
      }),
      signalAccount({
        recipientAliases: {
          "accd2cf3-8cb5-49c2-8904-5c4ce428c772": "+15036195666",
        },
      }),
    );

    expect(msg).toMatchObject({
      chatId: "signal:+15036195666",
      senderId: "accd2cf3-8cb5-49c2-8904-5c4ce428c772",
      senderName: "Cameron",
      text: "please reply",
    });
  });

  test("routes group messages only when mention policy permits them", () => {
    const account = signalAccount({
      groupMode: "mention",
      allowedGroups: ["group-1"],
      mentionPatterns: ["letta"],
    });

    expect(
      signalInboundFromSseEvent(
        receiveEvent({
          envelope: {
            sourceNumber: "+15555550123",
            sourceName: "Alice",
            timestamp: 111,
            dataMessage: {
              timestamp: 111,
              message: "quiet background chatter",
              groupInfo: { groupId: "group-1", groupName: "Friends" },
            },
          },
        }),
        account,
      ),
    ).toBeNull();

    expect(
      signalInboundFromSseEvent(
        receiveEvent({
          envelope: {
            sourceNumber: "+15555550123",
            sourceName: "Alice",
            timestamp: 112,
            dataMessage: {
              timestamp: 112,
              message: "letta can you look at this?",
              groupInfo: { groupId: "group-1", groupName: "Friends" },
            },
          },
        }),
        account,
      ),
    ).toMatchObject({
      channel: "signal",
      accountId: "personal",
      chatId: "group:group-1",
      chatType: "channel",
      senderId: "+15555550123",
      senderName: "Alice",
      chatLabel: "Friends",
      text: "letta can you look at this?",
      timestamp: 112,
      messageId: "112:+15555550123",
      threadId: null,
      isMention: true,
      isOpenChannel: false,
    });
  });

  test("keeps reaction target author in the generated target message id", () => {
    const msg = signalInboundFromSseEvent(
      receiveEvent({
        envelope: {
          sourceNumber: "+15555550123",
          sourceName: "Alice",
          reactionMessage: {
            emoji: "👍",
            targetAuthor: "+15555550199",
            targetSentTimestamp: 99,
            groupInfo: { groupId: "group-1", groupName: "Friends" },
          },
        },
      }),
      signalAccount({ groupMode: "open" }),
    );

    expect(msg).toMatchObject({
      chatId: "group:group-1",
      text: "Alice reacted 👍",
      reaction: {
        action: "added",
        emoji: "👍",
        targetMessageId: "99:+15555550199",
        targetSenderId: "+15555550199",
      },
    });
  });

  test("copies inbound image attachments when media download is enabled", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "signal-media-test-"));
    const attachmentsDir = join(tempDir, "attachments");
    mkdirSync(attachmentsDir, { recursive: true });
    __testOverrideChannelsRoot(join(tempDir, "channels"));
    __testOverrideSignalAttachmentSearchDirs([attachmentsDir]);
    try {
      const imageBytes = Buffer.from("fake-jpeg");
      const sourcePath = join(attachmentsDir, "photo.jpg");
      writeFileSync(sourcePath, imageBytes);

      const msg = signalInboundFromSseEvent(
        receiveEvent({
          envelope: {
            sourceNumber: "+15555550123",
            sourceName: "Alice",
            timestamp: 222,
            dataMessage: {
              timestamp: 222,
              attachments: [
                {
                  id: "att-1",
                  contentType: "image/jpeg",
                  localPath: sourcePath,
                  filename: sourcePath,
                  size: imageBytes.byteLength,
                },
              ],
            },
          },
        }),
        signalAccount({ downloadMedia: true }),
      );

      expect(msg?.text).toBe("[image attached]");
      expect(msg?.attachments).toHaveLength(1);
      const attachment = msg?.attachments?.[0];
      expect(attachment).toMatchObject({
        id: "att-1",
        name: "photo.jpg",
        mimeType: "image/jpeg",
        sizeBytes: imageBytes.byteLength,
        kind: "image",
        imageDataBase64: imageBytes.toString("base64"),
      });
      expect(attachment?.localPath).not.toBe(sourcePath);
      expect(attachment?.localPath && existsSync(attachment.localPath)).toBe(
        true,
      );
      expect(
        attachment?.localPath ? readFileSync(attachment.localPath) : null,
      ).toEqual(imageBytes);

      const content = msg ? formatChannelNotification(msg) : [];
      expect(content[2]).toEqual({
        type: "image",
        source: {
          type: "base64",
          media_type: "image/jpeg",
          data: imageBytes.toString("base64"),
        },
      });
    } finally {
      __testOverrideSignalAttachmentSearchDirs(null);
      __testOverrideChannelsRoot(null);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("resolves signal-cli relative attachment paths from attachment dirs", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "signal-relative-media-test-"));
    const attachmentsDir = join(tempDir, "attachments");
    mkdirSync(attachmentsDir, { recursive: true });
    __testOverrideChannelsRoot(join(tempDir, "channels"));
    __testOverrideSignalAttachmentSearchDirs([attachmentsDir]);
    try {
      const imageBytes = Buffer.from("fake-relative-jpeg");
      const sourcePath = join(attachmentsDir, "abc123.png");
      writeFileSync(sourcePath, imageBytes);

      const msg = signalInboundFromSseEvent(
        receiveEvent({
          envelope: {
            sourceNumber: "+15555550123",
            sourceName: "Alice",
            timestamp: 333,
            dataMessage: {
              timestamp: 333,
              attachments: [
                {
                  id: "att-2",
                  contentType: "image/png",
                  storedFilename: "abc123.png",
                  size: imageBytes.byteLength,
                },
              ],
            },
          },
        }),
        signalAccount({ downloadMedia: true }),
      );

      expect(msg?.attachments).toHaveLength(1);
      expect(msg?.attachments?.[0]).toMatchObject({
        id: "att-2",
        name: "abc123.png",
        mimeType: "image/png",
        kind: "image",
      });
    } finally {
      __testOverrideSignalAttachmentSearchDirs(null);
      __testOverrideChannelsRoot(null);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("does not resolve attachment paths outside attachment dirs", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "signal-traversal-media-test-"));
    const attachmentsDir = join(tempDir, "attachments");
    mkdirSync(attachmentsDir, { recursive: true });
    __testOverrideChannelsRoot(join(tempDir, "channels"));
    __testOverrideSignalAttachmentSearchDirs([attachmentsDir]);
    try {
      const secretBytes = Buffer.from("not-a-signal-attachment");
      writeFileSync(join(tempDir, "secret.jpg"), secretBytes);

      const msg = signalInboundFromSseEvent(
        receiveEvent({
          envelope: {
            sourceNumber: "+15555550123",
            sourceName: "Alice",
            timestamp: 334,
            dataMessage: {
              timestamp: 334,
              attachments: [
                {
                  id: "att-escape",
                  contentType: "image/jpeg",
                  storedFilename: "attachments/../secret.jpg",
                  size: secretBytes.byteLength,
                },
              ],
            },
          },
        }),
        signalAccount({ downloadMedia: true }),
      );

      expect(msg?.text).toBe("[image attached]");
      expect(msg?.attachments).toBeUndefined();
    } finally {
      __testOverrideSignalAttachmentSearchDirs(null);
      __testOverrideChannelsRoot(null);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("resolves metadata-only audio attachments by receive timestamp", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "signal-audio-media-test-"));
    const attachmentsDir = join(tempDir, "attachments");
    mkdirSync(attachmentsDir, { recursive: true });
    __testOverrideChannelsRoot(join(tempDir, "channels"));
    __testOverrideSignalAttachmentSearchDirs([attachmentsDir]);
    try {
      const audioBytes = Buffer.from("fake-audio");
      const sourcePath = join(attachmentsDir, "downloaded-audio-without-ext");
      writeFileSync(sourcePath, audioBytes);
      const timestamp = 1_781_637_600_000;
      utimesSync(sourcePath, new Date(timestamp), new Date(timestamp));

      const msg = signalInboundFromSseEvent(
        receiveEvent({
          envelope: {
            sourceNumber: "+15555550123",
            sourceName: "Alice",
            timestamp,
            dataMessage: {
              timestamp,
              attachments: [
                {
                  contentType: "audio/mpeg",
                  size: audioBytes.byteLength,
                },
              ],
            },
          },
        }),
        signalAccount({ downloadMedia: true }),
      );

      expect(msg?.text).toBe("[audio attached]");
      expect(msg?.attachments).toHaveLength(1);
      const attachment = msg?.attachments?.[0];
      expect(attachment).toMatchObject({
        name: "downloaded-audio-without-ext",
        mimeType: "audio/mpeg",
        sizeBytes: audioBytes.byteLength,
        kind: "audio",
      });
      expect(attachment?.localPath).not.toBe(sourcePath);
      expect(
        attachment?.localPath ? readFileSync(attachment.localPath) : null,
      ).toEqual(audioBytes);

      const content = msg ? formatChannelNotification(msg) : [];
      expect(content).toHaveLength(2);
      const notificationPart = content[1];
      const notificationText =
        typeof notificationPart === "object" &&
        notificationPart !== null &&
        "text" in notificationPart &&
        typeof notificationPart.text === "string"
          ? notificationPart.text
          : "";
      expect(notificationText).toContain("<attachment ");
      expect(notificationText).toContain('kind="audio"');
      expect(notificationText).toContain('local_path="');
    } finally {
      __testOverrideSignalAttachmentSearchDirs(null);
      __testOverrideChannelsRoot(null);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("adds transcription errors for audio attachments when transcription is enabled but unconfigured", async () => {
    const previousOpenAiKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const adapter = createSignalAdapter(
        signalAccount({ transcribeVoice: true }),
        {
          client: {
            check: async () => undefined,
            sendMessage: async () => "1",
            sendReaction: async () => undefined,
            sendTyping: async () => undefined,
            streamEvents: async () => undefined,
          },
        },
      );
      const prepared = await adapter.prepareInboundMessage?.({
        channel: "signal",
        accountId: "personal",
        chatId: "signal:+15555550123",
        senderId: "+15555550123",
        senderName: "Alice",
        text: "[audio attached]",
        timestamp: Date.now(),
        messageId: "1:+15555550123",
        chatType: "direct",
        attachments: [
          {
            name: "voice.mp3",
            mimeType: "audio/mpeg",
            sizeBytes: 10,
            kind: "audio",
            localPath: "/tmp/voice.mp3",
          },
        ],
      });

      expect(prepared?.attachments?.[0]?.transcriptionError).toBe(
        "OPENAI_API_KEY not set; transcription skipped.",
      );
    } finally {
      if (previousOpenAiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousOpenAiKey;
      }
    }
  });
});

describe("SignalChannelAdapter", () => {
  test("passes text styles to signal-cli sends", async () => {
    const sendMessage = mock(async () => "123");
    const client: SignalClientLike = {
      check: async () => undefined,
      sendMessage,
      sendReaction: async () => undefined,
      sendTyping: async () => undefined,
      streamEvents: async () => undefined,
    };
    const adapter = createSignalAdapter(signalAccount(), { client });

    await adapter.sendMessage({
      channel: "signal",
      accountId: "personal",
      chatId: "signal:+15555550123",
      text: "Bold mono",
      textStyle: ["0:4:BOLD", "5:4:MONOSPACE"],
    });

    expect(sendMessage).toHaveBeenCalledWith({
      target: { kind: "recipient", recipient: "+15555550123" },
      message: "Bold mono",
      attachments: undefined,
      textStyle: ["0:4:BOLD", "5:4:MONOSPACE"],
    });
  });

  test("self-chat mode blocks outbound sends to non-self targets", async () => {
    const sendMessage = mock(async () => "123");
    const client: SignalClientLike = {
      check: async () => undefined,
      sendMessage,
      sendReaction: async () => undefined,
      sendTyping: async () => undefined,
      streamEvents: async () => undefined,
    };
    const adapter = createSignalAdapter(signalAccount({ selfChatMode: true }), {
      client,
    });

    await expect(
      adapter.sendMessage({
        channel: "signal",
        accountId: "personal",
        chatId: "signal:+15555550123",
        text: "do not send",
      }),
    ).rejects.toThrow(/self-chat mode/);
    expect(sendMessage).not.toHaveBeenCalled();

    await adapter.sendMessage({
      channel: "signal",
      accountId: "personal",
      chatId: "signal:+15555550100",
      text: "note to self",
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  test("sends and stops typing indicators during turn lifecycle", async () => {
    const sendTyping = mock(async () => undefined);
    const client: SignalClientLike = {
      check: async () => undefined,
      sendMessage: async () => "1",
      sendReaction: async () => undefined,
      sendTyping,
      streamEvents: async (_onEvent, signal) => {
        await new Promise<void>((resolve) => {
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    };
    const adapter = createSignalAdapter(signalAccount(), { client });
    await adapter.start();

    await adapter.handleTurnLifecycleEvent?.({
      type: "processing",
      batchId: "batch-1",
      sources: [
        {
          channel: "signal",
          accountId: "personal",
          chatId: "signal:+15555550123",
          chatType: "direct",
          agentId: "agent-signal",
          conversationId: "default",
        },
      ],
    });
    await adapter.handleTurnLifecycleEvent?.({
      type: "finished",
      batchId: "batch-1",
      outcome: "completed",
      stopReason: "end_turn",
      sources: [
        {
          channel: "signal",
          accountId: "personal",
          chatId: "signal:+15555550123",
          chatType: "direct",
          agentId: "agent-signal",
          conversationId: "default",
        },
      ],
    });

    expect(sendTyping).toHaveBeenCalledTimes(2);
    expect(sendTyping).toHaveBeenNthCalledWith(1, {
      target: { kind: "recipient", recipient: "+15555550123" },
    });
    expect(sendTyping).toHaveBeenNthCalledWith(2, {
      target: { kind: "recipient", recipient: "+15555550123" },
      stop: true,
    });
    await adapter.stop();
  });

  test("does not keep retrying typing indicators after initial failure", async () => {
    const sendTyping = mock(async () => {
      throw new Error("typing unsupported");
    });
    const client: SignalClientLike = {
      check: async () => undefined,
      sendMessage: async () => "1",
      sendReaction: async () => undefined,
      sendTyping,
      streamEvents: async () => undefined,
    };
    const adapter = createSignalAdapter(signalAccount(), { client });
    await adapter.start();

    await adapter.handleTurnLifecycleEvent?.({
      type: "processing",
      batchId: "batch-1",
      sources: [
        {
          channel: "signal",
          accountId: "personal",
          chatId: "signal:accd2cf3-8cb5-49c2-8904-5c4ce428c772",
          chatType: "direct",
          agentId: "agent-signal",
          conversationId: "default",
        },
      ],
    });

    expect(sendTyping).toHaveBeenCalledTimes(1);
    await adapter.stop();
  });

  test("stop resolves while the event loop is sleeping before retry", async () => {
    let resolveFirstStream: (() => void) | null = null;
    const firstStream = new Promise<void>((resolve) => {
      resolveFirstStream = resolve;
    });
    const client: SignalClientLike = {
      check: async () => undefined,
      sendMessage: async () => "1",
      sendReaction: async () => undefined,
      sendTyping: async () => undefined,
      streamEvents: async () => {
        resolveFirstStream?.();
        throw new Error("stream failed");
      },
    };
    const adapter = createSignalAdapter(signalAccount(), {
      client,
      retryMs: 60_000,
    });
    const originalConsoleError = console.error;
    console.error = () => undefined;
    try {
      await adapter.start();
      await firstStream;
      await new Promise((resolve) => setTimeout(resolve, 0));

      const stopResult = await Promise.race([
        adapter.stop().then(() => "stopped"),
        new Promise((resolve) => setTimeout(() => resolve("timeout"), 100)),
      ]);

      expect(stopResult).toBe("stopped");
      expect(adapter.isRunning()).toBe(false);
    } finally {
      console.error = originalConsoleError;
    }
  });
});
