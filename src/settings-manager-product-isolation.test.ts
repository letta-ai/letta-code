import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { settingsManager } from "@/settings-manager";

test("persistSession skips HOME-local state under a product config root", async () => {
  const originalHome = process.env.HOME;
  const originalConfigDir = process.env.LETTA_CONFIG_DIR;
  const originalSkipKeychain = process.env.LETTA_SKIP_KEYCHAIN_CHECK;
  const home = mkdtempSync(join(tmpdir(), "letta-product-session-"));

  try {
    process.env.HOME = home;
    process.env.LETTA_CONFIG_DIR = join(home, ".dream");
    process.env.LETTA_SKIP_KEYCHAIN_CHECK = "1";
    await settingsManager.reset();
    await settingsManager.initialize();
    await settingsManager.loadLocalProjectSettings(home);

    expect(() =>
      settingsManager.persistSession(
        "agent-product-session",
        "conv-product-session",
        home,
      ),
    ).not.toThrow();
    await settingsManager.flush();

    expect(settingsManager.getGlobalLastSession()).toEqual({
      agentId: "agent-product-session",
      conversationId: "conv-product-session",
    });
    expect(existsSync(join(home, ".letta"))).toBe(false);
  } finally {
    await settingsManager.reset();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalConfigDir === undefined) delete process.env.LETTA_CONFIG_DIR;
    else process.env.LETTA_CONFIG_DIR = originalConfigDir;
    if (originalSkipKeychain === undefined)
      delete process.env.LETTA_SKIP_KEYCHAIN_CHECK;
    else process.env.LETTA_SKIP_KEYCHAIN_CHECK = originalSkipKeychain;
    rmSync(home, { recursive: true, force: true });
  }
});
