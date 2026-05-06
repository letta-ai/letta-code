import { describe, expect, test } from "bun:test";
import {
  isChannelAccountCreateCommand,
  isChannelAccountUpdateCommand,
  isChannelSetConfigCommand,
} from "../../websocket/listener/protocol-inbound";

describe("whatsapp protocol-inbound validators", () => {
  test("valid whatsapp account create passes", () => {
    expect(
      isChannelAccountCreateCommand({
        type: "channel_account_create",
        channel_id: "whatsapp",
        request_id: "r1",
        account: {
          config: {
            agent_id: "agent-1",
            self_chat_mode: true,
            group_mode: "disabled",
          },
        },
      }),
    ).toBe(true);
  });

  test("valid whatsapp account update passes", () => {
    expect(
      isChannelAccountUpdateCommand({
        type: "channel_account_update",
        channel_id: "whatsapp",
        account_id: "acct",
        request_id: "r1",
        patch: {
          config: {
            self_chat_mode: false,
            group_mode: "mention",
            allowed_groups: ["120363@g.us"],
            mention_patterns: ["\\bloop\\b"],
            download_media: true,
            media_max_bytes: 1048576,
          },
        },
      }),
    ).toBe(true);
  });

  test("rejects invalid group mode", () => {
    expect(
      isChannelAccountCreateCommand({
        type: "channel_account_create",
        channel_id: "whatsapp",
        request_id: "r1",
        account: { config: { group_mode: "all" } },
      }),
    ).toBe(false);
  });

  test("rejects unknown nested plugin config fields", () => {
    expect(
      isChannelAccountCreateCommand({
        type: "channel_account_create",
        channel_id: "whatsapp",
        request_id: "r1",
        account: { config: { token: "not-used" } },
      }),
    ).toBe(false);
  });

  test("valid channel_set_config passes through plugin_config", () => {
    expect(
      isChannelSetConfigCommand({
        type: "channel_set_config",
        channel_id: "whatsapp",
        request_id: "r1",
        config: {
          dm_policy: "open",
          plugin_config: {
            agent_id: "agent-1",
            self_chat_mode: false,
          },
        },
      }),
    ).toBe(true);
  });
});
