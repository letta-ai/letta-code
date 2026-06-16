import { describe, expect, mock, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __testOverrideChannelsRoot } from "@/channels/config";
import type { SignalChannelAccount } from "@/channels/types";
import {
  __testOverrideSignalAttachmentSearchDirs,
  createSignalAdapter,
  type SignalClientLike,
  signalInboundFromSseEvent,
} from "./adapter";

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
    __testOverrideChannelsRoot(join(tempDir, "channels"));
    try {
      const imageBytes = Buffer.from("fake-jpeg");
      const sourcePath = join(tempDir, "photo.jpg");
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
    } finally {
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
});

describe("SignalChannelAdapter", () => {
  test("passes text styles to signal-cli sends", async () => {
    const sendMessage = mock(async () => "123");
    const client: SignalClientLike = {
      check: async () => undefined,
      sendMessage,
      sendReaction: async () => undefined,
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

  test("stop resolves while the event loop is sleeping before retry", async () => {
    let resolveFirstStream: (() => void) | null = null;
    const firstStream = new Promise<void>((resolve) => {
      resolveFirstStream = resolve;
    });
    const client: SignalClientLike = {
      check: async () => undefined,
      sendMessage: async () => "1",
      sendReaction: async () => undefined,
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
