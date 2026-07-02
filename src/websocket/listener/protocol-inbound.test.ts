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
    {
      type: "runtime_start",
      request_id: "r0",
      create_agent: { body: { name: "Agent" }, pin_global: false },
      create_conversation: { body: { summary: "New conversation" } },
      cwd: "/tmp/project",
      mode: "acceptEdits",
      client_info: { name: "test", title: "Test", version: "1.0.0" },
      external_tools: [
        {
          scope_id: "scope-1",
          tools: [
            {
              name: "lookup_ticket",
              description: "Lookup a ticket",
              parameters: { type: "object", properties: {} },
            },
          ],
        },
      ],
    },
    {
      type: "external_tool_call_response",
      request_id: "ext-1",
      result: { content: [{ type: "text", text: "ok" }] },
    },
    { type: "agent_list", request_id: "r1", query: { limit: 10 } },
    { type: "agent_retrieve", request_id: "r2", agent_id: "agent-1" },
    { type: "agent_create", request_id: "r3", body: { name: "Agent" } },
    {
      type: "agent_update",
      request_id: "r4",
      agent_id: "agent-1",
      body: { name: "Updated" },
    },
    { type: "agent_delete", request_id: "r5", agent_id: "agent-1" },
    {
      type: "conversation_list",
      request_id: "r6",
      query: { agent_id: "agent-1", limit: 10 },
    },
    {
      type: "conversation_retrieve",
      request_id: "r7",
      conversation_id: "conv-1",
    },
    {
      type: "conversation_create",
      request_id: "r8",
      body: { agent_id: "agent-1" },
    },
    {
      type: "conversation_update",
      request_id: "r9",
      conversation_id: "conv-1",
      body: { summary: "Updated" },
    },
    {
      type: "conversation_recompile",
      request_id: "r10",
      conversation_id: "conv-1",
      body: { dry_run: true },
    },
    {
      type: "conversation_fork",
      request_id: "r11",
      conversation_id: "conv-1",
      body: { hidden: true },
    },
    {
      type: "conversation_messages_list",
      request_id: "r12",
      conversation_id: "conv-1",
      query: { limit: 10 },
    },
    {
      type: "conversation_compact",
      request_id: "r13",
      conversation_id: "conv-1",
      body: { agent_id: "agent-1" },
    },
  ])("accepts $type", (message) => {
    const parsed = parseServerMessage(Buffer.from(JSON.stringify(message)));
    expect(parsed).toEqual(message);
  });

  test.each([
    { type: "runtime_start", request_id: "r0", create_agent: { body: [] } },
    {
      type: "runtime_start",
      request_id: "r0",
      agent_id: "agent-1",
      create_conversation: [],
    },
    {
      type: "runtime_start",
      request_id: "r0",
      agent_id: "agent-1",
      mode: "bad",
    },
    {
      type: "runtime_start",
      request_id: "r0",
      agent_id: "agent-1",
      client_info: { title: "missing name" },
    },
    {
      type: "runtime_start",
      request_id: "r0",
      agent_id: "agent-1",
      external_tools: [{ tools: [{ name: "bad" }] }],
    },
    {
      type: "external_tool_call_response",
      request_id: "ext-1",
      result: { content: "not-array" },
    },
    { type: "agent_list", request_id: "r1", query: "bad" },
    { type: "agent_retrieve", request_id: "r2" },
    { type: "agent_create", request_id: "r3", body: null },
    { type: "agent_update", request_id: "r4", agent_id: "agent-1" },
    { type: "agent_delete", request_id: "r5" },
    { type: "conversation_list", request_id: "r4", query: [] },
    { type: "conversation_retrieve", request_id: "r5" },
    { type: "conversation_create", request_id: "r6", body: "bad" },
    { type: "conversation_update", request_id: "r7", body: {} },
    {
      type: "conversation_recompile",
      request_id: "r8",
      conversation_id: "conv-1",
      body: [],
    },
    {
      type: "conversation_fork",
      request_id: "r9",
      conversation_id: "conv-1",
      body: [],
    },
    {
      type: "conversation_messages_list",
      request_id: "r10",
      conversation_id: "conv-1",
      query: "bad",
    },
    {
      type: "conversation_compact",
      request_id: "r11",
      conversation_id: "conv-1",
      body: [],
    },
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
        config: { token: "test-token", default_permission_mode: "banana" },
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
