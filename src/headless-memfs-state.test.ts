import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import { createHeadlessModContext } from "@/headless-mod-adapter";
import { settingsManager } from "@/settings-manager";

const originalHome = process.env.HOME;
let testHomeDir: string;

beforeEach(async () => {
  await settingsManager.reset();
  testHomeDir = await mkdtemp(join(tmpdir(), "letta-headless-memfs-"));
  process.env.HOME = testHomeDir;
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

describe("headless memfs state", () => {
  test("stateless headless projection does not rewrite settings", async () => {
    await settingsManager.initialize();
    settingsManager.updateSettings({
      agents: [{ agentId: "agent-headless", memfs: true }],
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    const settingsPath = join(testHomeDir, ".letta", "settings.json");
    const before = await readFile(settingsPath, "utf8");

    const context = createHeadlessModContext({
      agent: {
        id: "agent-headless",
        name: "Agent",
        llm_config: { model: "anthropic/claude-sonnet-4-6" },
      } as AgentState,
      conversationId: "conversation-1",
      memfsEnabled: false,
    });

    expect(context.memfs.enabled).toBe(false);
    expect(context.memfs.memoryDir).toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 100));
    const after = await readFile(settingsPath, "utf8");
    expect(after).toBe(before);
  });

  test("setMemfsEnabled false still stores exactly one row", async () => {
    await settingsManager.initialize();

    settingsManager.setMemfsEnabled("agent-persistent", false);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(settingsManager.getSettings().agents).toEqual([
      expect.objectContaining({
        agentId: "agent-persistent",
        memfs: false,
      }),
    ]);

    const settingsPath = join(testHomeDir, ".letta", "settings.json");
    const persisted = JSON.parse(await readFile(settingsPath, "utf8")) as {
      agents?: Array<{ agentId: string; memfs?: boolean }>;
    };
    expect(persisted.agents).toEqual([
      expect.objectContaining({
        agentId: "agent-persistent",
        memfs: false,
      }),
    ]);
  });
});
