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
      account: { token: "test-token" },
    };
    expect(isChannelAccountCreateCommand(msg)).toBe(true);
  });

  test("valid discord account create with agent_id passes", () => {
    const msg = {
      type: "channel_account_create",
      channel_id: "discord",
      request_id: "r1",
      account: { token: "test-token", agent_id: "a-1" },
    };
    expect(isChannelAccountCreateCommand(msg)).toBe(true);
  });

  test("discord account create without discord fields still passes (validator only checks discord-specific fields)", () => {
    const msg = {
      type: "channel_account_create",
      channel_id: "discord",
      request_id: "r1",
      account: { bot_token: "xoxb-test" },
    };
    // validator only rejects discord-specific-field violations; Slack-style
    // extra fields should not cause rejection by the discord validator.
    expect(isChannelAccountCreateCommand(msg)).toBe(true);
  });

  test("valid discord account update passes", () => {
    const msg = {
      type: "channel_account_update",
      channel_id: "discord",
      account_id: "acc-1",
      request_id: "r1",
      patch: { token: "new-token" },
    };
    expect(isChannelAccountUpdateCommand(msg)).toBe(true);
  });

  test("valid discord config set passes", () => {
    const msg = {
      type: "channel_set_config",
      channel_id: "discord",
      request_id: "r1",
      config: { token: "new-token" },
    };
    expect(isChannelSetConfigCommand(msg)).toBe(true);
  });

  test("discord channel_id is accepted by isChannelAccountCreateCommand", () => {
    const msg = {
      type: "channel_account_create",
      channel_id: "discord",
      request_id: "r1",
      account: { token: "t" },
    };
    expect(isChannelAccountCreateCommand(msg)).toBe(true);
  });
});
