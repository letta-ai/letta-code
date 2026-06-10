import { describe, expect, test } from "bun:test";
import {
  isChannelAccountCreateCommand,
  isChannelAccountUpdateCommand,
  isChannelSetConfigCommand,
  parseServerMessage,
} from "@/websocket/listener/protocol-inbound";

describe("app-server protocol hard cut", () => {
  test.each([
    "request_state",
    "change_cwd",
    "cancel_run",
    "recover_pending_approvals",
    "change_mode",
    "message",
  ])("rejects legacy command %s", (type) => {
    const parsed = parseServerMessage(Buffer.from(JSON.stringify({ type })));
    expect(parsed).toBeNull();
  });
});

describe("agent/conversation management protocol-inbound validators", () => {
  test.each([
    { type: "agent_list", request_id: "r1", query: { limit: 10 } },
    { type: "agent_retrieve", request_id: "r2", agent_id: "agent-1" },
    { type: "agent_create", request_id: "r3", body: { name: "Agent" } },
    {
      type: "conversation_list",
      request_id: "r4",
      query: { agent_id: "agent-1", limit: 10 },
    },
    {
      type: "conversation_retrieve",
      request_id: "r5",
      conversation_id: "conv-1",
    },
    {
      type: "conversation_create",
      request_id: "r6",
      body: { agent_id: "agent-1" },
    },
  ])("accepts $type", (message) => {
    const parsed = parseServerMessage(Buffer.from(JSON.stringify(message)));
    expect(parsed).toEqual(message);
  });

  test.each([
    { type: "agent_list", request_id: "r1", query: "bad" },
    { type: "agent_retrieve", request_id: "r2" },
    { type: "agent_create", request_id: "r3", body: null },
    { type: "conversation_list", request_id: "r4", query: [] },
    { type: "conversation_retrieve", request_id: "r5" },
    { type: "conversation_create", request_id: "r6", body: "bad" },
  ])("rejects invalid $type", (message) => {
    const parsed = parseServerMessage(Buffer.from(JSON.stringify(message)));
    expect(parsed).toBeNull();
  });
});

describe("discord protocol-inbound validators", () => {
  test("valid discord account create passes", () => {
    const msg = {
      type: "channel_account_create",
      channel_id: "discord",
      request_id: "r1",
      account: { config: { token: "test-token" } },
    };
    expect(isChannelAccountCreateCommand(msg)).toBe(true);
  });

  test("valid discord account create with agent_id passes", () => {
    const msg = {
      type: "channel_account_create",
      channel_id: "discord",
      request_id: "r1",
      account: {
        config: {
          token: "test-token",
          agent_id: "a-1",
          default_permission_mode: "acceptEdits",
          allowed_channels: ["channel-1"],
        },
      },
    };
    expect(isChannelAccountCreateCommand(msg)).toBe(true);
  });

  test("valid discord account create with generic config passes", () => {
    const msg = {
      type: "channel_account_create",
      channel_id: "discord",
      request_id: "r1",
      account: {
        config: {
          token: "test-token",
          agent_id: "a-1",
          default_permission_mode: "bypassPermissions",
          allowed_channels: ["channel-1"],
        },
      },
    };
    expect(isChannelAccountCreateCommand(msg)).toBe(true);
  });

  test("discord account create rejects non-string allowed_channels", () => {
    const msg = {
      type: "channel_account_create",
      channel_id: "discord",
      request_id: "r1",
      account: {
        config: { token: "test-token", allowed_channels: ["channel-1", 42] },
      },
    };
    expect(isChannelAccountCreateCommand(msg)).toBe(false);
  });

  test("discord account create rejects invalid default_permission_mode", () => {
    const msg = {
      type: "channel_account_create",
      channel_id: "discord",
      request_id: "r1",
      account: {
        config: { token: "test-token", default_permission_mode: "memory" },
      },
    };
    expect(isChannelAccountCreateCommand(msg)).toBe(false);
  });

  test("discord account create rejects unknown nested plugin config fields", () => {
    const msg = {
      type: "channel_account_create",
      channel_id: "discord",
      request_id: "r1",
      account: { config: { bot_token: "xoxb-test" } },
    };
    expect(isChannelAccountCreateCommand(msg)).toBe(false);
  });

  test("discord account create rejects legacy top-level plugin fields", () => {
    const msg = {
      type: "channel_account_create",
      channel_id: "discord",
      request_id: "r1",
      account: { token: "test-token" },
    };
    expect(isChannelAccountCreateCommand(msg)).toBe(false);
  });

  test("valid discord account update passes", () => {
    const msg = {
      type: "channel_account_update",
      channel_id: "discord",
      account_id: "acc-1",
      request_id: "r1",
      patch: {
        config: { token: "new-token", default_permission_mode: "acceptEdits" },
      },
    };
    expect(isChannelAccountUpdateCommand(msg)).toBe(true);
  });

  test("valid discord config set passes", () => {
    const msg = {
      type: "channel_set_config",
      channel_id: "discord",
      request_id: "r1",
      config: {
        plugin_config: {
          token: "new-token",
          default_permission_mode: "bypassPermissions",
          allowed_channels: ["channel-1"],
        },
      },
    };
    expect(isChannelSetConfigCommand(msg)).toBe(true);
  });

  test("valid discord config set with nested generic config passes", () => {
    const msg = {
      type: "channel_set_config",
      channel_id: "discord",
      request_id: "r1",
      config: {
        plugin_config: { token: "new-token", allowed_channels: ["channel-1"] },
      },
    };
    expect(isChannelSetConfigCommand(msg)).toBe(true);
  });

  test("discord channel_id is accepted by isChannelAccountCreateCommand", () => {
    const msg = {
      type: "channel_account_create",
      channel_id: "discord",
      request_id: "r1",
      account: { config: { token: "t" } },
    };
    expect(isChannelAccountCreateCommand(msg)).toBe(true);
  });
});
