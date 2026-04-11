import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  const parts = (content as Array<{ type: "text"; text: string }>).filter(
    (part) => part.type === "text",
  );
  expect(parts.length).toBeGreaterThanOrEqual(2);

  const [reminderPart, notificationPart] = parts;
  if (!reminderPart || !notificationPart) {
    throw new Error("Expected reminder and notification text parts");
  }

  return [reminderPart, notificationPart];
}

describe("formatChannelNotification", () => {
  test("formats structured content parts with reminder first and xml second", async () => {
    const msg: InboundChannelMessage = {
      channel: "telegram",
      chatId: "12345",
      senderId: "67890",
      senderName: "John",
      text: "Hello from Telegram!",
      timestamp: Date.now(),
      messageId: "msg-42",
    };

    const content = await formatChannelNotification(msg);
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

  test("serializes attachment metadata in xml when attachments are present", () => {
    const msg: InboundChannelMessage = {
      channel: "telegram",
      chatId: "123",
      senderId: "456",
      text: "",
      timestamp: Date.now(),
      attachments: [
        {
          kind: "file",
          name: "report.pdf",
          mimeType: "application/pdf",
          sizeBytes: 2048,
          localPath: "/tmp/report.pdf",
        },
      ],
    };

    const xml = buildChannelNotificationXml(msg);

    expect(xml).toContain("<attachments>");
    expect(xml).toContain('kind="file"');
    expect(xml).toContain('name="report.pdf"');
    expect(xml).toContain('mime_type="application/pdf"');
    expect(xml).toContain('size_bytes="2048"');
    expect(xml).toContain('local_path="/tmp/report.pdf"');
  });

  test("appends inline image parts for downloaded image attachments", async () => {
    const dir = mkdtempSync(join(tmpdir(), "letta-channel-image-"));
    const imagePath = join(dir, "tiny.png");
    writeFileSync(
      imagePath,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+XM7sAAAAASUVORK5CYII=",
        "base64",
      ),
    );

    try {
      const msg: InboundChannelMessage = {
        channel: "telegram",
        chatId: "123",
        senderId: "456",
        text: "see attached",
        timestamp: Date.now(),
        attachments: [
          {
            kind: "image",
            name: "tiny.png",
            mimeType: "image/png",
            localPath: imagePath,
          },
        ],
      };

      const content = await formatChannelNotification(msg);
      expect(Array.isArray(content)).toBe(true);
      if (!Array.isArray(content)) {
        return;
      }

      expect(content).toHaveLength(3);
      expect(content[2]).toEqual({
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: expect.any(String),
        },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
