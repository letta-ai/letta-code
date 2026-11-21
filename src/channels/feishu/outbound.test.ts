import { describe, expect, test } from "bun:test";
import {
  buildFeishuCreateTextMessage,
  buildFeishuReplyTextMessage,
  buildFeishuTextContent,
} from "@/channels/feishu/outbound";

describe("feishu outbound", () => {
  test("MessageChannel send uses receive_id_type=chat_id", () => {
    const payload = buildFeishuCreateTextMessage({
      receiveId: "oc_group",
      text: "hello from letta",
    });
    expect(payload).toEqual({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: "oc_group",
        msg_type: "text",
        content: '{"text":"hello from letta"}',
      },
    });
  });

  test("text content is JSON-encoded", () => {
    expect(buildFeishuTextContent('say "hi"')).toBe('{"text":"say \\"hi\\""}');
  });

  test("reply payload can target a topic thread", () => {
    expect(
      buildFeishuReplyTextMessage({
        messageId: "om_parent",
        text: "reply",
        replyInThread: true,
      }),
    ).toEqual({
      path: { message_id: "om_parent" },
      data: {
        msg_type: "text",
        content: '{"text":"reply"}',
        reply_in_thread: true,
      },
    });
  });
});
