import { afterEach, describe, expect, test } from "bun:test";

import {
  buildDynamicMessageChannelSchema,
  buildDynamicMessageChannelToolDefinition,
  clearDynamicMessageChannelToolCache,
} from "@/channels/message-tool";
import { ChannelRegistry, getChannelRegistry } from "@/channels/registry";
import type { ChannelAdapter } from "@/channels/types";

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
    clearDynamicMessageChannelToolCache();
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
    expect(properties.action?.enum).toEqual([
      "send",
      "react",
      "upload-file",
      "send-rich",
    ]);
  });

  test("keeps Telegram-only tool actions narrowed to Telegram-supported actions", async () => {
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
    expect(properties.action?.enum).toEqual([
      "send",
      "send-rich",
      "react",
      "upload-file",
    ]);
  });

  test("builds description from the same discovery result as the schema", async () => {
    const registry = new ChannelRegistry();
    registry.registerAdapter(createRunningAdapter("slack", "acct-slack"));
    registry.registerAdapter(createRunningAdapter("telegram", "acct-telegram"));

    const resolved = await buildDynamicMessageChannelToolDefinition(
      "Base MessageChannel description.",
      {
        type: "object",
        properties: {
          action: { type: "string" },
          channel: { type: "string" },
          chat_id: { type: "string" },
        },
        required: ["action", "channel", "chat_id"],
        additionalProperties: false,
      },
    );

    const properties = resolved.schema.properties as Record<
      string,
      { enum?: string[] }
    >;
    expect(resolved.description).toContain(
      "Currently active channels: Slack, Telegram.",
    );
    expect(resolved.description).toContain(
      "Available actions across the active channels: send, react, upload-file, send-rich.",
    );
    expect(resolved.description).not.toContain("View in web link");
    expect(properties.channel?.enum).toEqual(["slack", "telegram"]);
    expect(properties.action?.enum).toEqual([
      "send",
      "react",
      "upload-file",
      "send-rich",
    ]);
  });

  test("can narrow discovery to the channels bound for the current conversation scope", async () => {
    const registry = new ChannelRegistry();
    registry.registerAdapter(createRunningAdapter("slack", "acct-slack"));
    registry.registerAdapter(createRunningAdapter("telegram", "acct-telegram"));

    const resolved = await buildDynamicMessageChannelToolDefinition(
      "Base MessageChannel description.",
      {
        type: "object",
        properties: {
          action: { type: "string" },
          channel: { type: "string" },
          chat_id: { type: "string" },
        },
        required: ["action", "channel", "chat_id"],
        additionalProperties: false,
      },
      {
        channels: [{ channelId: "slack", accountId: "acct-slack" }],
      },
    );

    const properties = resolved.schema.properties as Record<
      string,
      { enum?: string[] }
    >;
    expect(resolved.description).toContain("Currently active channels: Slack.");
    expect(resolved.description).toContain(
      "Plain assistant text is not delivered to that external user.",
    );
    expect(resolved.description).toContain(
      "If a user-visible reply is appropriate, your final action for the turn must be one MessageChannel call",
    );
    expect(resolved.description).toContain(
      "If no user-visible response is appropriate, do not call MessageChannel and do not send an empty acknowledgement.",
    );
    expect(resolved.description).toContain(
      'For lightweight acknowledgement, prefer action="react" when supported.',
    );
    expect(resolved.description).toContain(
      "If the useful response belongs later, schedule the follow-up instead of sending a placeholder.",
    );
    expect(resolved.description).toContain(
      'For Slack requests that require nontrivial work or several tool calls, send one short MessageChannel call with action="send" before starting other tools.',
    );
    expect(resolved.description).toContain("View in web link.");
    expect(resolved.description).not.toContain("Telegram");
    expect(properties.channel?.enum).toEqual(["slack"]);
    expect(properties.action?.enum).toEqual(["send", "react", "upload-file"]);
  });

  test("does not add Slack work acknowledgement guidance to Telegram-only scoped descriptions", async () => {
    const registry = new ChannelRegistry();
    registry.registerAdapter(createRunningAdapter("slack", "acct-slack"));
    registry.registerAdapter(createRunningAdapter("telegram", "acct-telegram"));

    const resolved = await buildDynamicMessageChannelToolDefinition(
      "Base MessageChannel description.",
      {
        type: "object",
        properties: {
          action: { type: "string" },
          channel: { type: "string" },
          chat_id: { type: "string" },
        },
        required: ["action", "channel", "chat_id"],
        additionalProperties: false,
      },
      {
        channels: [{ channelId: "telegram", accountId: "acct-telegram" }],
      },
    );

    const properties = resolved.schema.properties as Record<
      string,
      { enum?: string[] }
    >;
    expect(resolved.description).toContain(
      "Currently active channels: Telegram.",
    );
    expect(resolved.description).not.toContain(
      "For Slack requests that require nontrivial work",
    );
    expect(resolved.description).not.toContain("View in web link");
    expect(properties.channel?.enum).toEqual(["telegram"]);
    expect(properties.action?.enum).toEqual([
      "send",
      "send-rich",
      "react",
      "upload-file",
    ]);
  });
});
