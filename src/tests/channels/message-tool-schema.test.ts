import { afterEach, describe, expect, test } from "bun:test";

import { buildDynamicMessageChannelSchema } from "../../channels/messageTool";
import { ChannelRegistry, getChannelRegistry } from "../../channels/registry";
import type { ChannelAdapter } from "../../channels/types";

function createRunningAdapter(
  channelId: "slack" | "telegram",
  accountId: string,
): ChannelAdapter {
  return {
    id: `${channelId}:${accountId}`,
    channelId,
    accountId,
    name: channelId,
    start: async () => {},
    stop: async () => {},
    isRunning: () => true,
    sendMessage: async () => ({ messageId: "msg-1" }),
    sendDirectReply: async () => {},
  };
}

describe("buildDynamicMessageChannelSchema", () => {
  afterEach(async () => {
    const registry = getChannelRegistry();
    if (registry) {
      await registry.stopAll();
    }
  });

  test("injects active channel enum and plugin-owned actions", async () => {
    const registry = new ChannelRegistry();
    registry.registerAdapter(createRunningAdapter("slack", "acct-slack"));
    registry.registerAdapter(createRunningAdapter("telegram", "acct-telegram"));

    const schema = await buildDynamicMessageChannelSchema({
      type: "object",
      properties: {
        action: { type: "string" },
        channel: { type: "string" },
        chat_id: { type: "string" },
      },
      required: ["action", "channel", "chat_id"],
      additionalProperties: false,
    });

    const properties = schema.properties as Record<string, { enum?: string[] }>;
    expect(properties.channel?.enum).toEqual(["slack", "telegram"]);
    expect(properties.action?.enum).toEqual(["send", "react", "upload-file"]);
  });

  test("keeps Telegram-only tool actions narrowed to send", async () => {
    const registry = new ChannelRegistry();
    registry.registerAdapter(createRunningAdapter("telegram", "acct-telegram"));

    const schema = await buildDynamicMessageChannelSchema({
      type: "object",
      properties: {
        action: { type: "string" },
        channel: { type: "string" },
        chat_id: { type: "string" },
      },
      required: ["action", "channel", "chat_id"],
      additionalProperties: false,
    });

    const properties = schema.properties as Record<string, { enum?: string[] }>;
    expect(properties.channel?.enum).toEqual(["telegram"]);
    expect(properties.action?.enum).toEqual(["send"]);
  });
});
