import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inheritForkToolset } from "@/agent/subagents/fork-conversation";
import { settingsManager } from "@/settings-manager";
import { clearCapturedToolExecutionContexts } from "@/tools/manager";
import { prepareToolExecutionContextForResolvedTarget } from "@/tools/toolset";

const originalHome = process.env.HOME;
let testHomeDir: string;

beforeEach(async () => {
  await settingsManager.reset();
  testHomeDir = await mkdtemp(join(tmpdir(), "letta-fork-toolset-"));
  process.env.HOME = testHomeDir;
  await settingsManager.initialize();
});

afterEach(async () => {
  clearCapturedToolExecutionContexts();
  await settingsManager.reset();
  await rm(testHomeDir, { recursive: true, force: true });
  process.env.HOME = originalHome;
});

describe("fork subagent toolset inheritance", () => {
  test("does not copy the parent's request-scoped async question include", async () => {
    const agentId = "agent-parent";
    settingsManager.setToolsetPreference(agentId, "codex", "conv-parent");
    const parent = await prepareToolExecutionContextForResolvedTarget({
      toolsetPreference: "codex",
      conversationId: "conv-parent",
      clientToolset: { include: ["AskUserQuestionAsync"] },
    });
    expect(parent.preparedToolContext.loadedToolNames).toContain(
      "AskUserQuestion",
    );
    await inheritForkToolset(agentId, "conv-parent", "conv-child");
    const child = await prepareToolExecutionContextForResolvedTarget({
      toolsetPreference: settingsManager.getToolsetPreference(
        agentId,
        "conv-child",
      ),
      conversationId: "conv-child",
    });
    expect(child.preparedToolContext.loadedToolNames).not.toContain(
      "AskUserQuestion",
    );
  });

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
