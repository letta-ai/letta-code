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
  const parts = content as Array<{ type: "text"; text: string }>;
  expect(parts).toHaveLength(2);

  const [reminderPart, notificationPart] = parts;
  if (!reminderPart || !notificationPart) {
    throw new Error("Expected reminder and notification text parts");
  }

  return [reminderPart, notificationPart];
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
    expect(reminder).toContain(
      'Use action="send", channel="telegram", and chat_id="12345"',
    );
    expect(reminder).toContain('action="react"');
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
      threadId: "1712790000.000050",
      chatType: "channel",
    };

    const reminder = buildChannelReminderText(msg);

    expect(reminder).toContain("stay in the same Slack thread automatically");
    expect(reminder).not.toContain("reply_to_message_id");
  });

  test("escapes XML special characters in notification text without over-escaping quotes", () => {
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
    expect(xml).toContain('"friends"');
    expect(xml).toContain("'here'");
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

  test("includes Slack thread metadata in the notification xml", () => {
    const msg: InboundChannelMessage = {
      channel: "slack",
      chatId: "C123",
      senderId: "U123",
      text: "threaded hello",
      timestamp: Date.now(),
      messageId: "1712800000.000100",
      threadId: "1712790000.000050",
      chatType: "channel",
    };

    const xml = buildChannelNotificationXml(msg);

    expect(xml).toContain('thread_id="1712790000.000050"');
  });

  test("includes reaction metadata in the notification xml", () => {
    const msg: InboundChannelMessage = {
      channel: "slack",
      chatId: "C123",
      senderId: "U123",
      text: "Slack reaction added: :eyes:",
      timestamp: Date.now(),
      messageId: "1712800001.000200",
      threadId: "1712790000.000050",
      chatType: "channel",
      reaction: {
        action: "added",
        emoji: "eyes",
        targetMessageId: "1712800000.000100",
        targetSenderId: "U999",
      },
    };

    const xml = buildChannelNotificationXml(msg);

    expect(xml).toContain(
      '<reaction action="added" emoji="eyes" target_message_id="1712800000.000100" target_sender_id="U999" />',
    );
  });

  test("renders attempted_transcription child node when transcription is present", () => {
    const msg: InboundChannelMessage = {
      channel: "telegram",
      chatId: "123",
      senderId: "456",
      text: "",
      timestamp: Date.now(),
      attachments: [
        {
          kind: "audio",
          localPath: "/tmp/voice.ogg",
          name: "voice.ogg",
          mimeType: "audio/ogg",
          transcription: "Hello, this is a voice memo test.",
        },
      ],
    };

    const xml = buildChannelNotificationXml(msg);

    expect(xml).toContain(
      "<attempted_transcription>Hello, this is a voice memo test.</attempted_transcription>",
    );
    expect(xml).toContain("</attachment>");
    expect(xml).not.toMatch(/<attachment[^>]*\/>/);
    expect(xml).toMatch(/<attachment[^>]*>\n/);
  });

  test("renders self-closing attachment when transcription is absent", () => {
    const msg: InboundChannelMessage = {
      channel: "telegram",
      chatId: "123",
      senderId: "456",
      text: "",
      timestamp: Date.now(),
      attachments: [
        {
          kind: "audio",
          localPath: "/tmp/voice.ogg",
          name: "voice.ogg",
          mimeType: "audio/ogg",
        },
      ],
    };

    const xml = buildChannelNotificationXml(msg);

    expect(xml).toMatch(/<attachment[^>]*\/>/);
    expect(xml).not.toContain("<attempted_transcription>");
    expect(xml).not.toContain("</attachment>");
  });

  test("escapes XML in transcription text", () => {
    const msg: InboundChannelMessage = {
      channel: "telegram",
      chatId: "123",
      senderId: "456",
      text: "",
      timestamp: Date.now(),
      attachments: [
        {
          kind: "audio",
          localPath: "/tmp/voice.ogg",
          transcription: "He said <hello> & goodbye",
        },
      ],
    };

    const xml = buildChannelNotificationXml(msg);

    expect(xml).toContain("&lt;hello&gt;");
    expect(xml).toContain("&amp;");
    expect(xml).not.toContain("<hello>");
  });

  test("includes Slack thread starter and history context in the notification xml", () => {
    const msg: InboundChannelMessage = {
      channel: "slack",
      chatId: "C123",
      senderId: "U123",
      senderName: "Charles",
      text: "please help",
      timestamp: Date.now(),
      messageId: "1712800000.000100",
      threadId: "1712790000.000050",
      chatType: "channel",
      threadContext: {
        label:
          "Slack thread in #random: Original question from the thread root",
        starter: {
          messageId: "1712790000.000050",
          senderId: "U111",
          senderName: "Alice",
          text: "Original question from the thread root",
        },
        history: [
          {
            messageId: "1712795000.000060",
            senderId: "U222",
            senderName: "Bob",
            text: "Some follow-up before the bot was tagged",
          },
        ],
      },
    };

    const xml = buildChannelNotificationXml(msg);

    expect(xml).toContain("<thread-context");
    expect(xml).toContain(
      'label="Slack thread in #random: Original question from the thread root"',
    );
    expect(xml).toContain(
      '<thread-starter sender_id="U111" sender_name="Alice" message_id="1712790000.000050">',
    );
    expect(xml).toContain("Original question from the thread root");
    expect(xml).toContain("<thread-history>");
    expect(xml).toContain(
      '<thread-message sender_id="U222" sender_name="Bob" message_id="1712795000.000060">',
    );
    expect(xml).toContain("Some follow-up before the bot was tagged");
    expect(xml).toContain("please help");
  });

  test("emits image content parts for inbound image attachments", () => {
    const msg: InboundChannelMessage = {
      channel: "slack",
      chatId: "C123",
      senderId: "U123",
      text: "See screenshot",
      timestamp: Date.now(),
      messageId: "1712800000.000100",
      chatType: "channel",
      attachments: [
        {
          id: "F123",
          name: "screenshot.png",
          mimeType: "image/png",
          kind: "image",
          localPath: "/tmp/screenshot.png",
          imageDataBase64: "YWJj",
        },
      ],
    };

    const content = formatChannelNotification(msg);

    expect(content).toHaveLength(3);
    expect(content[2]).toEqual({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: "YWJj",
      },
    });
  });
});
