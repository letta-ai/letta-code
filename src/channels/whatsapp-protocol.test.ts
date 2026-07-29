import { describe, expect, test } from "bun:test";
import { isValidChannelPluginConfigPayload } from "./account-config";

describe("whatsapp gateway config validators", () => {
  test("valid whatsapp account create passes", () => {
    expect(
      isValidChannelPluginConfigPayload("whatsapp", {
        config: {
          agent_id: "agent-1",
          message_prefix: "[bot] ",
          self_chat_mode: true,
          group_mode: "disabled",
        },
      }),
    ).toBe(true);
  });

  test("valid whatsapp account update passes", () => {
    expect(
      isValidChannelPluginConfigPayload("whatsapp", {
        config: {
          self_chat_mode: false,
          group_mode: "mention",
          allowed_groups: ["120363@g.us"],
          mention_patterns: ["\\bloop\\b"],
          download_media: true,
          media_max_bytes: 1048576,
          attachment_filter: true,
          attachment_mime_types: ["image/png"],
          attachment_allowed_recipients: ["15551234567"],
          attachment_allowed_paths: ["/tmp/uploads"],
          attachment_path_recursive: true,
        },
      }),
    ).toBe(true);
  });

  test("rejects invalid group mode", () => {
    expect(
      isValidChannelPluginConfigPayload("whatsapp", {
        config: { group_mode: "all" },
      }),
    ).toBe(false);
  });

  test("rejects non-string message prefixes", () => {
    expect(
      isValidChannelPluginConfigPayload("whatsapp", {
        config: { message_prefix: 42 },
      }),
    ).toBe(false);
  });

  test("rejects unknown nested plugin config fields", () => {
    expect(
      isValidChannelPluginConfigPayload("whatsapp", {
        config: { token: "not-used" },
      }),
    ).toBe(false);
  });

  test("valid channel_set_config passes through plugin_config", () => {
    expect(
      isValidChannelPluginConfigPayload(
        "whatsapp",
        {
          dm_policy: "open",
          plugin_config: {
            agent_id: "agent-1",
            self_chat_mode: false,
            attachment_filter: true,
            attachment_mime_types: ["image/png"],
          },
        },
        "plugin_config",
      ),
    ).toBe(true);
  });
});
