import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { settingsManager } from "@/settings-manager";

const originalHome = process.env.HOME;
let testHomeDir: string;

beforeEach(async () => {
  await settingsManager.reset();
  testHomeDir = await mkdtemp(join(tmpdir(), "letta-toolset-settings-"));
  process.env.HOME = testHomeDir;
  await settingsManager.initialize();
});

afterEach(async () => {
  await settingsManager.reset();
  await rm(testHomeDir, { recursive: true, force: true });
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
});

describe("Settings Manager - Toolset Preferences", () => {
  test("named conversations default to auto instead of the default conversation override", () => {
    settingsManager.setToolsetPreference("agent-toolset", "codex");

    expect(settingsManager.getToolsetPreference("agent-toolset")).toBe("codex");
    expect(
      settingsManager.getToolsetPreference("agent-toolset", "conv-new"),
    ).toBe("auto");
  });

  test("stores and clears manual overrides per conversation", () => {
    settingsManager.setToolsetPreference("agent-toolset", "codex", "conv-a");

    expect(
      settingsManager.getToolsetPreference("agent-toolset", "conv-a"),
    ).toBe("codex");
    expect(
      settingsManager.getToolsetPreference("agent-toolset", "conv-b"),
    ).toBe("auto");
    settingsManager.setToolsetPreference("agent-toolset", "default", "conv-b");

    settingsManager.setToolsetPreference("agent-toolset", "auto", "conv-a");
    expect(
      settingsManager.getToolsetPreference("agent-toolset", "conv-a"),
    ).toBe("auto");
    expect(
      settingsManager
        .getSettings()
        .agents?.find((setting) => setting.agentId === "agent-toolset")
        ?.toolsetsByConversation,
    ).toEqual({ "conv-b": "default" });
    expect(
      settingsManager.getToolsetPreference("agent-toolset", "conv-b"),
    ).toBe("default");
  });

  test("persists default and named conversation overrides independently", async () => {
    settingsManager.setToolsetPreference("agent-toolset-persist", "gemini");
    settingsManager.setToolsetPreference(
      "agent-toolset-persist",
      "codex",
      "conv-a",
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    await settingsManager.reset();
    await settingsManager.initialize();

    expect(settingsManager.getToolsetPreference("agent-toolset-persist")).toBe(
      "gemini",
    );
    expect(
      settingsManager.getToolsetPreference("agent-toolset-persist", "conv-a"),
    ).toBe("codex");
  });
});
