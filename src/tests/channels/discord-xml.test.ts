import { describe, expect, test } from "bun:test";
import type { InboundChannelMessage } from "../../channels/types";
import {
  buildChannelNotificationXml,
  buildChannelReminderText,
  formatChannelNotification,
} from "../../channels/xml";

describe("discord xml", () => {
  test("notification XML has source=discord", () => {
    const message: InboundChannelMessage = {
      channel: "discord",
      chatId: "channel-123",
      senderId: "user-1",
      senderName: "alice",
      messageId: "msg-1",
      text: "hello discord",
      timestamp: Date.now(),
    };
    const xml = buildChannelNotificationXml(message);
    expect(xml).toContain('source="discord"');
  });

  test("reminder text includes discord-specific capability hints", () => {
    const message: InboundChannelMessage = {
      channel: "discord",
      chatId: "channel-123",
      senderId: "user-1",
      senderName: "alice",
      messageId: "msg-1",
      text: "hey",
      timestamp: Date.now(),
    };
    const reminder = buildChannelReminderText(message);
    expect(reminder).toContain("discord");
    expect(reminder.toLowerCase()).toContain("react");
    expect(reminder).toContain("upload-file");
    expect(reminder).toContain("native Unicode emoji");
    expect(reminder).toContain("<:name:id>");
  });

  test("thread metadata appears in XML as thread_id", () => {
    const message: InboundChannelMessage = {
      channel: "discord",
      chatId: "channel-123",
      senderId: "user-1",
      senderName: "alice",
      messageId: "msg-1",
      text: "in a thread",
      threadId: "thread-999",
      timestamp: Date.now(),
    };
    const xml = buildChannelNotificationXml(message);
    expect(xml).toContain("thread-999");
    expect(xml).toMatch(/thread_id\s*=\s*"thread-999"/);
  });

  test("thread context renders thread-context, thread-starter, thread-history", () => {
    const message: InboundChannelMessage = {
      channel: "discord",
      chatId: "channel-123",
      senderId: "user-1",
      senderName: "alice",
      messageId: "msg-1",
      text: "replying in thread",
      threadId: "thread-999",
      timestamp: Date.now(),
      threadContext: {
        label: "Project Questions",
        starter: {
          messageId: "msg-0",
          senderId: "user-0",
          senderName: "bob",
          text: "How should we handle retries?",
        },
        history: [
          {
            messageId: "msg-0a",
            senderId: "user-2",
            senderName: "carol",
            text: "I'd exponential-backoff.",
          },
        ],
      },
    };
    const xml = buildChannelNotificationXml(message);
    expect(xml).toContain("<thread-context");
    expect(xml).toContain("<thread-starter");
    expect(xml).toContain("<thread-history>");
  });

  test("reaction metadata appears in XML", () => {
    const message: InboundChannelMessage = {
      channel: "discord",
      chatId: "channel-123",
      senderId: "user-1",
      senderName: "alice",
      messageId: "msg-1",
      text: "",
      timestamp: Date.now(),
      reaction: {
        action: "added",
        emoji: "🔥",
        targetMessageId: "msg-1",
      },
    };
    const xml = buildChannelNotificationXml(message);
    expect(xml).toContain("reaction");
    expect(xml).toContain("🔥");
    expect(xml).toContain("msg-1");
    expect(xml).toContain("added");
  });
});
