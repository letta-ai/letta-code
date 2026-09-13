import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __testOverrideChannelsRoot,
  readChannelConfig,
} from "@/channels/config";

let root: string | null = null;

afterEach(() => {
  __testOverrideChannelsRoot(null);
  if (root) {
    rmSync(root, { recursive: true, force: true });
    root = null;
  }
});

describe("Signal channel config", () => {
  test("loads legacy yaml config", () => {
    root = mkdtempSync(join(tmpdir(), "signal-config-"));
    const signalDir = join(root, "signal");
    mkdirSync(signalDir, { recursive: true });
    writeFileSync(
      join(signalDir, "config.yaml"),
      [
        "enabled: true",
        "dm_policy: open",
        "base_url: http://signal.local:8080",
        "account: '+15555550100'",
        "account_uuid: self-uuid",
        "agent_id: agent-signal",
        "group_mode: mention",
        "allowed_groups:",
        "  - group-1",
        "mention_patterns:",
        "  - letta",
        "download_media: true",
        "media_max_bytes: 1048576",
        "",
      ].join("\n"),
    );
    __testOverrideChannelsRoot(root);

    expect(readChannelConfig("signal")).toEqual({
      channel: "signal",
      enabled: true,
      dmPolicy: "open",
      allowedUsers: [],
      baseUrl: "http://signal.local:8080",
      account: "+15555550100",
      accountUuid: "self-uuid",
      agentId: "agent-signal",
      selfChatMode: false,
      groupMode: "mention",
      allowedGroups: ["group-1"],
      mentionPatterns: ["letta"],
      transcribeVoice: false,
      downloadMedia: true,
      mediaMaxBytes: 1048576,
    });
  });

  test("defaults legacy yaml media download on", () => {
    root = mkdtempSync(join(tmpdir(), "signal-config-"));
    const signalDir = join(root, "signal");
    mkdirSync(signalDir, { recursive: true });
    writeFileSync(
      join(signalDir, "config.yaml"),
      [
        "enabled: true",
        "dm_policy: pairing",
        "base_url: http://signal.local:8080",
        "account: '+15555550100'",
        "",
      ].join("\n"),
    );
    __testOverrideChannelsRoot(root);

    const config = readChannelConfig("signal");
    expect(config).toMatchObject({ channel: "signal", downloadMedia: true });
  });
});
