import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __testOverrideChannelsRoot,
  readChannelConfig,
} from "@/channels/config";

let root: string | null = null;

function clearRoot(): void {
  __testOverrideChannelsRoot(null);
  if (root) {
    rmSync(root, { recursive: true, force: true });
    root = null;
  }
}

afterEach(() => {
  clearRoot();
});

function writeDiscordConfig(lines: string[]): void {
  clearRoot();
  root = mkdtempSync(join(tmpdir(), "discord-config-"));
  const discordDir = join(root, "discord");
  mkdirSync(discordDir, { recursive: true });
  writeFileSync(join(discordDir, "config.yaml"), `${lines.join("\n")}\n`);
  __testOverrideChannelsRoot(root);
}

describe("Discord channel config", () => {
  test("loads guarded bot ingress mode from legacy yaml config", () => {
    writeDiscordConfig([
      "enabled: true",
      "token: discord-token",
      "dm_policy: pairing",
      "allow_bots: mentions",
    ]);

    expect(readChannelConfig("discord")).toEqual(
      expect.objectContaining({
        channel: "discord",
        allowBots: "mentions",
      }),
    );
  });

  test("rejects unsafe bot ingress modes from legacy yaml config", () => {
    for (const rawValue of ["true", "all"]) {
      writeDiscordConfig([
        "enabled: true",
        "token: discord-token",
        `allow_bots: ${rawValue}`,
      ]);

      expect(readChannelConfig("discord")).toBeNull();
    }
  });
});
