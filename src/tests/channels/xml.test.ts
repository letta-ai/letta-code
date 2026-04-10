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
): Array<{ type: "text"; text: string }> {
  expect(Array.isArray(content)).toBe(true);
  return content as Array<{ type: "text"; text: string }>;
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
    const parts = expectTextParts(content);

    expect(parts).toHaveLength(2);
    expect(parts[0].text).toContain("<system-reminder>");
    expect(parts[1].text).toContain("<channel-notification");
    expect(parts[1].text).toContain('source="telegram"');
    expect(parts[1].text).toContain('chat_id="12345"');
    expect(parts[1].text).toContain('sender_id="67890"');
    expect(parts[1].text).toContain('sender_name="John"');
    expect(parts[1].text).toContain('message_id="msg-42"');
    expect(parts[1].text).toContain("Hello from Telegram!");
    expect(parts[1].text).toContain("</channel-notification>");
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
