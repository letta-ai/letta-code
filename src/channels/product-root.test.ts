import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import {
  __testOverrideChannelsRoot,
  getChannelAccountsPath,
  getChannelsRoot,
} from "@/channels/config";
import { getWhatsAppAuthDir } from "@/channels/whatsapp/session";
import { getGlobalCommandsDir } from "@/cli/commands/custom";
import { getGlobalModsDirectory, getModCacheDirectory } from "@/mods/paths";

const originalHome = process.env.HOME;
const originalConfigDir = process.env.LETTA_CONFIG_DIR;

afterEach(() => {
  __testOverrideChannelsRoot(null);
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalConfigDir === undefined) delete process.env.LETTA_CONFIG_DIR;
  else process.env.LETTA_CONFIG_DIR = originalConfigDir;
});

test("channel credentials and sessions follow the product config root", () => {
  process.env.HOME = "/Users/alice";
  process.env.LETTA_CONFIG_DIR = "/Users/alice/.dream";

  expect(getChannelsRoot()).toBe(join("/Users/alice", ".dream", "channels"));
  expect(getChannelAccountsPath("slack")).toBe(
    join("/Users/alice", ".dream", "channels", "slack", "accounts.json"),
  );
  expect(getWhatsAppAuthDir("personal")).toBe(
    join("/Users/alice", ".dream", "channels", "whatsapp", "auth", "personal"),
  );
  expect(getGlobalCommandsDir()).toBe(
    join("/Users/alice", ".dream", "commands"),
  );
  expect(getGlobalModsDirectory()).toBe(join("/Users/alice", ".dream", "mods"));
  expect(getGlobalModsDirectory("/fallback-home", process.env)).toBe(
    join("/Users/alice", ".dream", "mods"),
  );
  expect(getModCacheDirectory()).toBe(
    join("/Users/alice", ".dream", "mod-cache"),
  );
});
