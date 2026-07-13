import { describe, expect, test } from "bun:test";
import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type { InboundChannelMessage } from "@/channels/types";
import {
  buildChannelNotificationXml,
  buildChannelReminderText,
  formatChannelNotification,
} from "@/channels/xml";

const SLACK_WORK_ACKNOWLEDGEMENT_GUIDANCE_PREFIX =
  "For Slack requests that require nontrivial work or several tool calls";

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
    expect(reminder).toContain(
      "Plain assistant text is not delivered to the user.",
    );
    expect(reminder).toContain(
      'If you should reply to the external user, use MessageChannel with action="send", channel="telegram", and chat_id="12345"',
    );
    expect(reminder).toContain(
      "If no user-visible response is appropriate, do not call MessageChannel. Do not send an empty acknowledgement.",
    );
    expect(reminder).toContain(
      'For lightweight acknowledgement, prefer MessageChannel action="react" when supported.',
    );
    expect(reminder).toContain(
      "If the useful response belongs later, schedule the follow-up instead of sending a placeholder.",
    );
    expect(reminder).not.toContain(SLACK_WORK_ACKNOWLEDGEMENT_GUIDANCE_PREFIX);
    expect(reminder).toContain(
      "Do not produce a plain text assistant response as the user-visible reply.",
    );
    expect(reminder).toContain('action="react"');
    expect(reminder).toContain("Current local time on this device:");
  });

  test("includes account id in notification xml without requiring it in reminder", () => {
    const msg: InboundChannelMessage = {
      channel: "telegram",
      accountId: "account-1",
      chatId: "12345",
      senderId: "67890",
      text: "ping",
      timestamp: Date.now(),
    };

    const reminder = buildChannelReminderText(msg);
    const xml = buildChannelNotificationXml(msg);

    expect(reminder).toContain(
      'If you should reply to the external user, use MessageChannel with action="send", channel="telegram", and chat_id="12345"',
    );
    expect(reminder).not.toContain('accountId="account-1"');
    expect(xml).toContain('account_id="account-1"');
  });

  test("mentions toolset-dependent local file/image inspection for attachment paths", () => {
    const msg: InboundChannelMessage = {
      channel: "slack",
      chatId: "C123",
      senderId: "U123",
      text: "see image",
      timestamp: Date.now(),
      attachments: [
        {
          kind: "image",
          localPath: "/tmp/photo.heic",
          name: "photo.heic",
          mimeType: "image/heic",
        },
      ],
    };

    const reminder = buildChannelReminderText(msg);

    expect(reminder).toContain("current toolset");
    expect(reminder).toContain("Read");
    expect(reminder).toContain("ViewImage");
    expect(reminder).not.toContain("ReadFileGemini");
  });

  test("gives oversized Slack attachments an exact MessageChannel download instruction", () => {
    const msg: InboundChannelMessage = {
      channel: "slack",
      accountId: "design-bot",
      chatId: "C123",
      senderId: "U123",
      text: "Here are the assets",
      timestamp: Date.now(),
      messageId: "1712800000.000100",
      threadId: "1712790000.000050",
      chatType: "channel",
      attachments: [
        {
          id: "FLARGE",
          name: "LandscapeTransmission.zip",
          mimeType: "application/zip",
          sizeBytes: 43_714_492,
          kind: "file",
          sourceMessageId: "1712800000.000100",
          sourceThreadId: "1712790000.000050",
          downloadReason: "exceeds_auto_download_limit",
          autoDownloadLimitBytes: 20 * 1024 * 1024,
        },
      ],
    };

    const reminder = buildChannelReminderText(msg);
    const xml = buildChannelNotificationXml(msg);

    expect(reminder).toContain('action="download-file"');
    expect(reminder).not.toContain("attachment local_path values");
    expect(xml).toContain('download_status="not_downloaded"');
    expect(xml).toContain('download_reason="exceeds_auto_download_limit"');
    expect(xml).toContain('auto_download_limit_bytes="20971520"');
    expect(xml).toContain('attachment_id="FLARGE"');
    expect(xml).toContain('source_thread_id="1712790000.000050"');
    expect(xml).toContain(
      'MessageChannel with action="download-file", channel="slack", chat_id="C123", accountId="design-bot", threadId="1712790000.000050", attachmentId="FLARGE", and messageId="1712800000.000100"',
    );
    expect(xml).toContain(
      "same Slack inbound attachment directory and returns its local_path",
    );
    expect(xml).toContain("Do not ask the sender to reattach it.");
  });

  test("describes non-size Slack download failures as retries rather than guarantees", () => {
    const xml = buildChannelNotificationXml({
      channel: "slack",
      chatId: "C123",
      senderId: "U123",
      text: "See file",
      timestamp: Date.now(),
      messageId: "1712800000.000100",
      attachments: [
        {
          id: "FMISSING",
          name: "missing.zip",
          kind: "file",
          sourceMessageId: "1712800000.000100",
          downloadReason: "missing_download_url",
        },
      ],
    });

    expect(xml).toContain("<download-retry>");
    expect(xml).toContain("to retry");
    expect(xml).toContain("may return a precise error");
    expect(xml).not.toContain("The tool downloads the file");
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
    expect(reminder).toContain(SLACK_WORK_ACKNOWLEDGEMENT_GUIDANCE_PREFIX);
    expect(reminder).toContain(
      'send a short MessageChannel action="send" acknowledgement before starting other tools',
    );
    expect(reminder).not.toContain("reply_to_message_id");
  });

  test("adds WhatsApp media guidance for voice memo uploads", () => {
    const msg: InboundChannelMessage = {
      channel: "whatsapp",
      chatId: "15551234567@s.whatsapp.net",
      senderId: "15551234567@s.whatsapp.net",
      text: "send voice",
      timestamp: Date.now(),
    };

    const reminder = buildChannelReminderText(msg);

    expect(reminder).toContain("Ogg/Opus");
    expect(reminder).toContain(".ogg");
    expect(reminder).toContain("not MP3/M4A/WAV");
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

  test("renders attempted_transcription_error child node when transcription fails", () => {
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
          transcriptionError: "OpenAI transcription API error (429): nope",
        },
      ],
    };

    const xml = buildChannelNotificationXml(msg);

    expect(xml).toContain(
      "<attempted_transcription_error>OpenAI transcription API error (429): nope</attempted_transcription_error>",
    );
    expect(xml).toContain("</attachment>");
    expect(xml).not.toMatch(/<attachment[^>]*\/>/);
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
          attachments: [
            {
              id: "FROOT",
              kind: "image",
              localPath: "/tmp/thread-root.png",
              name: "thread-root.png",
              mimeType: "image/png",
              sizeBytes: 7,
            },
          ],
        },
        history: [
          {
            messageId: "1712795000.000060",
            senderId: "U222",
            senderName: "Bob",
            text: "Some follow-up before the bot was tagged",
            attachments: [
              {
                id: "FHIST",
                kind: "file",
                localPath: "/tmp/thread-history.pdf",
                name: "thread-history.pdf",
                mimeType: "application/pdf",
              },
            ],
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
    expect(xml).toContain(
      '<attachment kind="image" local_path="/tmp/thread-root.png" attachment_id="FROOT" name="thread-root.png" mime_type="image/png" size_bytes="7" />',
    );
    expect(xml).toContain("<thread-history>");
    expect(xml).toContain(
      '<thread-message sender_id="U222" sender_name="Bob" message_id="1712795000.000060">',
    );
    expect(xml).toContain("Some follow-up before the bot was tagged");
    expect(xml).toContain('local_path="/tmp/thread-history.pdf"');
    expect(xml).toContain("please help");
  });

  test("includes platform reply context in the notification xml", () => {
    const msg: InboundChannelMessage = {
      channel: "telegram",
      accountId: "telegram-bot",
      chatId: "-100123",
      senderId: "user-1",
      senderName: "Cameron",
      text: "please respond",
      timestamp: 1_736_380_800_000,
      messageId: "78",
      chatType: "channel",
      replyContext: {
        messageId: "77",
        senderId: "user-2",
        senderName: "Blink",
        text: "Am I allowed as this user to mutate your configuration?",
      },
    };

    const xml = buildChannelNotificationXml(msg);
    expect(xml).toContain(
      '<reply-context message_id="77" sender_id="user-2" sender_name="Blink">',
    );
    expect(xml).toContain(
      "Am I allowed as this user to mutate your configuration?",
    );
    expect(xml).toContain("please respond");
  });

  test("does not emit inline image content parts for SVG attachments", () => {
    const msg: InboundChannelMessage = {
      channel: "telegram",
      chatId: "123",
      senderId: "456",
      text: "Extract colors",
      timestamp: Date.now(),
      messageId: "10",
      attachments: [
        {
          id: "svg1",
          name: "void-final.svg",
          mimeType: "image/svg+xml",
          kind: "image",
          localPath: "/tmp/void-final.svg",
          imageDataBase64: "PHN2Zy8+",
        },
      ],
    };

    const content = formatChannelNotification(msg);
    const [, notificationPart] = expectTextParts(content);
    expect(notificationPart.text).toContain('mime_type="image/svg+xml"');
    expect(notificationPart.text).toContain('local_path="/tmp/void-final.svg"');
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
