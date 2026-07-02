import { describe, expect, test } from "bun:test";
import {
  isChannelAccountCreateCommand,
  isChannelAccountUpdateCommand,
  isChannelSetConfigCommand,
} from "@/websocket/listener/protocol-inbound";

describe("signal protocol-inbound validators", () => {
  test("valid signal account create passes", () => {
    expect(
      isChannelAccountCreateCommand({
        type: "channel_account_create",
        channel_id: "signal",
        request_id: "r1",
        account: {
          config: {
            base_url: "http://127.0.0.1:8080",
            account: "+15555550100",
            account_uuid: "self-uuid",
            agent_id: "agent-1",
            self_chat_mode: true,
            group_mode: "open",
            allowed_groups: ["group-1"],
            mention_patterns: ["letta"],
            recipient_aliases: { "uuid-1": "+15555550123" },
          },
        },
      }),
    ).toBe(true);
  });

  test("valid signal account update passes", () => {
    expect(
      isChannelAccountUpdateCommand({
        type: "channel_account_update",
        channel_id: "signal",
        account_id: "personal",
        request_id: "r1",
        patch: {
          config: {
            base_url: null,
            account: null,
            group_mode: "mention",
            self_chat_mode: false,
            transcribe_voice: true,
            download_media: true,
            media_max_bytes: 1048576,
          },
        },
      }),
    ).toBe(true);
  });

  test("rejects invalid signal plugin config fields", () => {
    expect(
      isChannelAccountCreateCommand({
        type: "channel_account_create",
        channel_id: "signal",
        request_id: "r1",
        account: { config: { group_mode: "all" } },
      }),
    ).toBe(false);

    expect(
      isChannelAccountCreateCommand({
        type: "channel_account_create",
        channel_id: "signal",
        request_id: "r1",
        account: { config: { token: "not-used" } },
      }),
    ).toBe(false);
  });

  test("valid channel_set_config passes through signal plugin_config", () => {
    expect(
      isChannelSetConfigCommand({
        type: "channel_set_config",
        channel_id: "signal",
        request_id: "r1",
        config: {
          dm_policy: "open",
          plugin_config: {
            base_url: "http://127.0.0.1:8080",
            account: "+15555550100",
            agent_id: "agent-1",
          },
        },
      }),
    ).toBe(true);
  });
});
