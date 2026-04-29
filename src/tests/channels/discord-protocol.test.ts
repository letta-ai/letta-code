import { describe, expect, test } from "bun:test";
import {
  isChannelAccountCreateCommand,
  isChannelAccountUpdateCommand,
  isChannelSetConfigCommand,
} from "../../websocket/listener/protocol-inbound";

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
      patch: { config: { token: "new-token" } },
    };
    expect(isChannelAccountUpdateCommand(msg)).toBe(true);
  });

  test("valid discord config set passes", () => {
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
