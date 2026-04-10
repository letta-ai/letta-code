import { describe, expect, test } from "bun:test";
import type { InboundChannelMessage } from "../../channels/types";
import { formatChannelNotification } from "../../channels/xml";

describe("formatChannelNotification", () => {
  test("formats a basic message with all fields", () => {
    const msg: InboundChannelMessage = {
      channel: "telegram",
      chatId: "12345",
      senderId: "67890",
      senderName: "John",
      text: "Hello from Telegram!",
      timestamp: Date.now(),
      messageId: "msg-42",
    };

    const xml = formatChannelNotification(msg);

    expect(xml).toContain("<channel-notification");
    expect(xml).toContain('source="telegram"');
    expect(xml).toContain('chat_id="12345"');
    expect(xml).toContain('sender_id="67890"');
    expect(xml).toContain('sender_name="John"');
    expect(xml).toContain('message_id="msg-42"');
    expect(xml).toContain("Hello from Telegram!");
    expect(xml).toContain("</channel-notification>");
  });

  test("prepends a system reminder describing reply semantics", () => {
    const msg: InboundChannelMessage = {
      channel: "telegram",
      chatId: "12345",
      senderId: "67890",
      text: "ping",
      timestamp: Date.now(),
    };

    const xml = formatChannelNotification(msg);

    expect(xml).toContain("<system-reminder>");
    expect(xml).toContain("must call the MessageChannel tool");
    expect(xml).toContain('channel="telegram" and chat_id="12345"');
    expect(xml).toContain("Current local time on this device:");
    expect(xml.indexOf("<system-reminder>")).toBeLessThan(
      xml.indexOf("<channel-notification"),
    );
  });

  test("escapes XML special characters in text", () => {
    const msg: InboundChannelMessage = {
      channel: "telegram",
      chatId: "123",
      senderId: "456",
      text: "Hello <world> & \"friends\" 'here'",
      timestamp: Date.now(),
    };

    const xml = formatChannelNotification(msg);

    expect(xml).toContain("&lt;world&gt;");
    expect(xml).toContain("&amp;");
    expect(xml).toContain("&quot;friends&quot;");
    expect(xml).toContain("&apos;here&apos;");
  });

  test("escapes XML special characters in attributes", () => {
    const msg: InboundChannelMessage = {
      channel: "telegram",
      chatId: "123",
      senderId: "456",
      senderName: 'John "The <Bot>"',
      text: "test",
      timestamp: Date.now(),
    };

    const xml = formatChannelNotification(msg);

    expect(xml).toContain("John &quot;The &lt;Bot&gt;&quot;");
  });

  test("omits optional fields when not present", () => {
    const msg: InboundChannelMessage = {
      channel: "telegram",
      chatId: "123",
      senderId: "456",
      text: "simple message",
      timestamp: Date.now(),
    };

    const xml = formatChannelNotification(msg);

    expect(xml).not.toContain("sender_name=");
    expect(xml).not.toContain("message_id=");
  });
});
