import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { settingsManager } from "@/settings-manager";
import { inheritForkToolset } from "./task";

const originalHome = process.env.HOME;
let testHomeDir: string;

beforeEach(async () => {
  await settingsManager.reset();
  testHomeDir = await mkdtemp(join(tmpdir(), "letta-fork-toolset-"));
  process.env.HOME = testHomeDir;
  await settingsManager.initialize();
});

afterEach(async () => {
  await settingsManager.reset();
  await rm(testHomeDir, { recursive: true, force: true });
  process.env.HOME = originalHome;
});

describe("fork subagent toolset inheritance", () => {
  test("copies and persists the parent conversation's manual toolset", async () => {
    const agentId = "agent-parent";
    const parentConversationId = "conv-parent";
    const forkConversationId = "conv-fork";

    settingsManager.setToolsetPreference(
      agentId,
      "codex",
      parentConversationId,
    );
    await inheritForkToolset(agentId, parentConversationId, forkConversationId);

    await settingsManager.reset();
    await settingsManager.initialize();

    expect(
      settingsManager.getToolsetPreference(agentId, forkConversationId),
    ).toBe("codex");
  });

  test("leaves model-derived toolsets on auto", async () => {
    await inheritForkToolset("agent-parent", "conv-parent", "conv-fork");

    expect(
      settingsManager.getToolsetPreference("agent-parent", "conv-fork"),
    ).toBe("auto");
  });
});
