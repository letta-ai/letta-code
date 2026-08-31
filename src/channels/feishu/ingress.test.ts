import { describe, expect, test } from "bun:test";
import { evaluateFeishuReceiveEvent } from "@/channels/feishu/ingress";

/** Official `im.message.receive_v1` example from Feishu Open Platform docs. */
const OFFICIAL_RECEIVE_EVENT = {
  schema: "2.0",
  header: {
    event_id: "5e3702a84e847582be8db7fb73283c02",
    event_type: "im.message.receive_v1",
    create_time: "1608725989000",
    token: "r-o6XhsDzikPVTDwsYvm3ftzkQ88QrCEY",
    app_id: "cli_9f5343ce03454433",
    tenant_key: "2ca1d211f64f6438",
  },
  event: {
    sender: {
      sender_id: {
        union_id: "on_8ed6aa67826108097d9ee143816345",
        user_id: "e33ggbyz",
        open_id: "ou_84aad35d084aa403a838cf73ee18467",
      },
      sender_type: "user",
      tenant_key: "736588c9260f175e",
    },
    message: {
      message_id: "om_5ce6d572455d361153b7cb51da133945",
      root_id: "om_5ce6d572455d361153b7cb5xxfsdfsdfsd",
      parent_id: "om_5ce6d572455d361153b7cb5xxfsdfsdfsd",
      create_time: "1609073151345",
      chat_id: "oc_5ce6d572455d361153b7xx51da133945",
      chat_type: "group",
      message_type: "text",
      content: '{"text":"@_user_1 hello"}',
      mentions: [
        {
          key: "@_user_1",
          id: {
            union_id: "on_8ed6aa67826108097d9ee143816345",
            user_id: "e33ggbyz",
            open_id: "ou_18eac85d35abgfef9e37c2b7b8c2fce",
          },
          name: "Tom",
          tenant_key: "736588c9260f175e",
        },
      ],
    },
  },
};

function groupEvent(overrides: {
  chatType?: string;
  content?: string;
  mentions?: unknown[];
  senderType?: string;
  senderOpenId?: string;
  messageId?: string;
  eventId?: string;
  messageType?: string;
}): unknown {
  return {
    schema: "2.0",
    header: {
      event_id: overrides.eventId ?? "evt_1",
      event_type: "im.message.receive_v1",
      create_time: "1608725989000",
      app_id: "cli_test",
    },
    event: {
      sender: {
        sender_id: {
          open_id: overrides.senderOpenId ?? "ou_sender",
        },
        sender_type: overrides.senderType ?? "user",
      },
      message: {
        message_id: overrides.messageId ?? "om_message",
        create_time: "1609073151345",
        chat_id: "oc_group",
        chat_type: overrides.chatType ?? "group",
        message_type: overrides.messageType ?? "text",
        content: overrides.content ?? '{"text":"hello"}',
        mentions: overrides.mentions,
      },
    },
  };
}

describe("feishu ingress", () => {
  test("official im.message.receive_v1 example parses identities", () => {
    const decision = evaluateFeishuReceiveEvent(OFFICIAL_RECEIVE_EVENT, {
      accountId: "acct-1",
      groupMode: "open",
    });
    expect(decision.action).toBe("deliver");
    if (decision.action !== "deliver") return;
    expect(decision.inbound.senderId).toBe(
      "ou_84aad35d084aa403a838cf73ee18467",
    );
    expect(decision.inbound.chatId).toBe("oc_5ce6d572455d361153b7xx51da133945");
    expect(decision.inbound.messageId).toBe(
      "om_5ce6d572455d361153b7cb51da133945",
    );
    expect(decision.inbound.chatType).toBe("channel");
    expect(decision.inbound.text).toBe("hello");
  });

  test("p2p chat_type maps to direct", () => {
    const decision = evaluateFeishuReceiveEvent(
      groupEvent({ chatType: "p2p", content: '{"text":"hi"}' }),
      { accountId: "acct-1" },
    );
    expect(decision.action).toBe("deliver");
    if (decision.action !== "deliver") return;
    expect(decision.inbound.chatType).toBe("direct");
    expect(decision.inbound.routedBy).toBe("dm");
    expect(decision.inbound.isMention).toBe(false);
  });

  test("group without bot mention is dropped in mention-only", () => {
    const decision = evaluateFeishuReceiveEvent(
      groupEvent({ content: '{"text":"hello"}' }),
      { accountId: "acct-1", groupMode: "mention-only" },
    );
    expect(decision).toEqual({ action: "drop", reason: "mention_required" });
  });

  test("group with bot mention is delivered", () => {
    const decision = evaluateFeishuReceiveEvent(
      groupEvent({
        content: '{"text":"@_user_1 hello"}',
        mentions: [
          {
            key: "@_user_1",
            mentioned_type: "bot",
            id: { open_id: "ou_bot" },
            name: "Letta",
          },
        ],
      }),
      { accountId: "acct-1", groupMode: "mention-only" },
    );
    expect(decision.action).toBe("deliver");
    if (decision.action !== "deliver") return;
    expect(decision.inbound.isMention).toBe(true);
    expect(decision.inbound.routedBy).toBe("mention");
    expect(decision.inbound.text).toBe("hello");
  });

  test("@all / @_all only is not a bot mention", () => {
    const allKey = evaluateFeishuReceiveEvent(
      groupEvent({
        content: '{"text":"@_all standup"}',
        mentions: [{ key: "@_all", name: "all" }],
      }),
      { accountId: "acct-1", groupMode: "mention-only" },
    );
    expect(allKey).toEqual({ action: "drop", reason: "broadcast_all" });

    const allText = evaluateFeishuReceiveEvent(
      groupEvent({ content: '{"text":"@all standup"}' }),
      { accountId: "acct-1", groupMode: "mention-only" },
    );
    expect(allText).toEqual({ action: "drop", reason: "broadcast_all" });
  });

  test("sender_type bot is dropped", () => {
    const decision = evaluateFeishuReceiveEvent(
      groupEvent({ senderType: "bot", content: '{"text":"beep"}' }),
      { accountId: "acct-1", groupMode: "open" },
    );
    expect(decision).toEqual({ action: "drop", reason: "bot_sender" });
  });

  test("image-only messages use a placeholder instead of crashing", () => {
    const decision = evaluateFeishuReceiveEvent(
      groupEvent({
        messageType: "image",
        content: '{"image_key":"img_123"}',
      }),
      { accountId: "acct-1", groupMode: "open" },
    );
    expect(decision.action).toBe("deliver");
    if (decision.action !== "deliver") return;
    expect(decision.inbound.text).toBe("[image]");
  });

  test("empty text in mention-only group without a mention is dropped", () => {
    const decision = evaluateFeishuReceiveEvent(
      groupEvent({ content: '{"text":""}' }),
      { accountId: "acct-1", groupMode: "mention-only" },
    );
    expect(decision.action).toBe("drop");
  });
});
