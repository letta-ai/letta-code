import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProjectSettings, updateProjectSettings } from "./settings";

test("product config override does not import or mutate HOME project settings", async () => {
  const originalCwd = process.cwd();
  const originalHome = process.env.HOME;
  const originalConfigDir = process.env.LETTA_CONFIG_DIR;
  const root = mkdtempSync(join(tmpdir(), "letta-product-settings-"));
  const home = join(root, "home");
  const legacyPath = join(home, ".letta", "settings.local.json");
  const productPath = join(home, ".dream", "settings.local.json");
  mkdirSync(join(home, ".letta"), { recursive: true });
  writeFileSync(legacyPath, JSON.stringify({ lastAgent: "agent-legacy" }));

  try {
    process.env.HOME = home;
    process.env.LETTA_CONFIG_DIR = join(home, ".dream");
    process.chdir(home);

    expect(await loadProjectSettings()).toBeNull();
    expect(await updateProjectSettings({ lastAgent: "agent-dream" })).toEqual({
      lastAgent: "agent-dream",
    });
    expect(JSON.parse(readFileSync(legacyPath, "utf8"))).toEqual({
      lastAgent: "agent-legacy",
    });
    expect(existsSync(productPath)).toBe(false);
  } finally {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalConfigDir === undefined) delete process.env.LETTA_CONFIG_DIR;
    else process.env.LETTA_CONFIG_DIR = originalConfigDir;
    rmSync(root, { recursive: true, force: true });
  }
});
