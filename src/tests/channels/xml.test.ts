import { describe, expect, test } from "bun:test";
import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type { InboundChannelMessage } from "../../channels/types";
import {
  buildChannelNotificationXml,
  buildChannelReminderText,
  formatChannelNotification,
} from "../../channels/xml";

function expectTextParts(
  content: MessageCreate["content"],
): [{ type: "text"; text: string }, { type: "text"; text: string }] {
  expect(Array.isArray(content)).toBe(true);
  const parts = content as Array<{ type: string; text?: string }>;
  // At least 2 text parts (reminder + notification); may have more (images)
  expect(parts.length).toBeGreaterThanOrEqual(2);

  const [reminderPart, notificationPart] = parts;
  if (!reminderPart || !notificationPart) {
    throw new Error("Expected reminder and notification text parts");
  }

  return [
    reminderPart as { type: "text"; text: string },
    notificationPart as { type: "text"; text: string },
  ];
}

describe("formatChannelNotification", () => {
  test("formats structured content parts with reminder first and xml second", () => {
    const msg: InboundChannelMessage = {
      channel: "telegram",
      chatId: "12345",
      senderId: "67890",
      senderName: "John",
      text: "Hello from Telegram!",
      timestamp: Date.now(),
      messageId: "msg-42",
    };

    const content = formatChannelNotification(msg);
    const [reminderPart, notificationPart] = expectTextParts(content);

    expect(reminderPart.text).toContain("<system-reminder>");
    expect(notificationPart.text).toContain("<channel-notification");
    expect(notificationPart.text).toContain('source="telegram"');
    expect(notificationPart.text).toContain('chat_id="12345"');
    expect(notificationPart.text).toContain('sender_id="67890"');
    expect(notificationPart.text).toContain('sender_name="John"');
    expect(notificationPart.text).toContain('message_id="msg-42"');
    expect(notificationPart.text).toContain("Hello from Telegram!");
    expect(notificationPart.text).toContain("</channel-notification>");
  });

  test("builds a reminder part describing reply semantics", () => {
    const msg: InboundChannelMessage = {
      channel: "telegram",
      chatId: "12345",
      senderId: "67890",
      text: "ping",
      timestamp: Date.now(),
    };

    const reminder = buildChannelReminderText(msg);

    expect(reminder).toContain("<system-reminder>");
    expect(reminder).toContain("must call the MessageChannel tool");
    expect(reminder).toContain('channel="telegram" and chat_id="12345"');
    expect(reminder).toContain("Current local time on this device:");
  });

  test("adds Slack thread guidance for channel notifications", () => {
    const msg: InboundChannelMessage = {
      channel: "slack",
      chatId: "C123",
      senderId: "U123",
      text: "ping",
      timestamp: Date.now(),
      messageId: "1712800000.000100",
      chatType: "channel",
    };

    const reminder = buildChannelReminderText(msg);

    expect(reminder).toContain('reply_to_message_id="1712800000.000100"');
    expect(reminder).toContain("stay in the same Slack thread");
  });

  test("escapes XML special characters in notification text", () => {
    const msg: InboundChannelMessage = {
      channel: "telegram",
      chatId: "123",
      senderId: "456",
      text: "Hello <world> & \"friends\" 'here'",
      timestamp: Date.now(),
    };

    const xml = buildChannelNotificationXml(msg);

    expect(xml).toContain("&lt;world&gt;");
    expect(xml).toContain("&amp;");
    expect(xml).toContain("&quot;friends&quot;");
    expect(xml).toContain("&apos;here&apos;");
  });

  test("escapes XML special characters in notification attributes", () => {
    const msg: InboundChannelMessage = {
      channel: "telegram",
      chatId: "123",
      senderId: "456",
      senderName: 'John "The <Bot>"',
      text: "test",
      timestamp: Date.now(),
    };

    const xml = buildChannelNotificationXml(msg);

    expect(xml).toContain("John &quot;The &lt;Bot&gt;&quot;");
  });

  test("includes ImageContent parts when message has images", () => {
    const msg: InboundChannelMessage = {
      channel: "telegram",
      chatId: "12345",
      senderId: "67890",
      senderName: "John",
      text: "Check this photo",
      timestamp: Date.now(),
      messageId: "msg-99",
      images: [{ data: "aGVsbG8=", mediaType: "image/jpeg" }],
    };

    const content = formatChannelNotification(msg);
    const parts = content as Array<{
      type: string;
      text?: string;
      source?: { type: string; media_type: string; data: string };
    }>;

    expect(parts).toHaveLength(3);
    expect(parts[0]!.type).toBe("text");
    expect(parts[1]!.type).toBe("text");
    expect(parts[2]!.type).toBe("image");
    expect(parts[2]!.source).toEqual({
      type: "base64",
      media_type: "image/jpeg",
      data: "aGVsbG8=",
    });
  });

  test("handles multiple images", () => {
    const msg: InboundChannelMessage = {
      channel: "telegram",
      chatId: "12345",
      senderId: "67890",
      text: "",
      timestamp: Date.now(),
      images: [
        { data: "img1data", mediaType: "image/jpeg" },
        { data: "img2data", mediaType: "image/png" },
      ],
    };

    const content = formatChannelNotification(msg);
    const parts = content as Array<{ type: string }>;

    expect(parts).toHaveLength(4); // 2 text + 2 images (no localPath = no path text part)
    expect(parts[2]!.type).toBe("image");
    expect(parts[3]!.type).toBe("image");
  });

  test("includes image path in system reminder when images have localPath", () => {
    const msg: InboundChannelMessage = {
      channel: "telegram",
      chatId: "12345",
      senderId: "67890",
      text: "Here's a photo",
      timestamp: Date.now(),
      images: [
        {
          data: "aGVsbG8=",
          mediaType: "image/jpeg",
          localPath: "/tmp/letta-attachments/telegram/12345/photo.jpg",
        },
      ],
    };

    const content = formatChannelNotification(msg);
    const parts = content as Array<{ type: string; text?: string }>;

    // 2 text (reminder + notification) + 1 image = 3 parts
    expect(parts).toHaveLength(3);
    // Path info is inside the system reminder (part 0)
    expect(parts[0]!.text).toContain(
      "saved to /tmp/letta-attachments/telegram/12345/photo.jpg",
    );
    expect(parts[0]!.text).toContain("image/jpeg");
    expect(parts[2]!.type).toBe("image");
  });

  test("omits image path in system reminder when images lack localPath", () => {
    const msg: InboundChannelMessage = {
      channel: "telegram",
      chatId: "12345",
      senderId: "67890",
      text: "No path",
      timestamp: Date.now(),
      images: [{ data: "aGVsbG8=", mediaType: "image/jpeg" }],
    };

    const content = formatChannelNotification(msg);
    const parts = content as Array<{ type: string; text?: string }>;

    // 2 text (reminder + notification) + 1 image = 3 parts
    expect(parts).toHaveLength(3);
    expect(parts[0]!.text).not.toContain("saved to");
    expect(parts[2]!.type).toBe("image");
  });

  test("omits optional notification attributes when not present", () => {
    const msg: InboundChannelMessage = {
      channel: "telegram",
      chatId: "123",
      senderId: "456",
      text: "simple message",
      timestamp: Date.now(),
    };

    const xml = buildChannelNotificationXml(msg);

    expect(xml).not.toContain("sender_name=");
    expect(xml).not.toContain("message_id=");
  });
});
