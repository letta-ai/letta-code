import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  forkParentConversation,
  inheritForkToolset,
} from "@/agent/subagents/fork-conversation";
import { __testSetBackend } from "@/backend";
import { LocalBackend } from "@/backend/local";
import { settingsManager } from "@/settings-manager";
import { clearCapturedToolExecutionContexts } from "@/tools/manager";
import { prepareToolExecutionContextForScope } from "@/tools/toolset";

const originalHome = process.env.HOME;
let testHomeDir: string;

beforeEach(async () => {
  await settingsManager.reset();
  testHomeDir = await mkdtemp(join(tmpdir(), "letta-fork-toolset-"));
  process.env.HOME = testHomeDir;
  await settingsManager.initialize();
});

afterEach(async () => {
  __testSetBackend(null);
  clearCapturedToolExecutionContexts();
  await settingsManager.reset();
  await rm(testHomeDir, { recursive: true, force: true });
  process.env.HOME = originalHome;
});

describe("fork subagent toolset inheritance", () => {
  test("a real fork does not inherit persistent client preferences from its parent", async () => {
    const backend = new LocalBackend({
      storageDir: join(testHomeDir, "backend"),
      memfsEnabled: false,
    });
    __testSetBackend(backend);
    const agent = await backend.createAgent({
      name: "Fork preference fixture",
      model: "anthropic/claude-sonnet-4-6",
    });
    const conversation = await backend.createConversation({
      agent_id: agent.id,
    });
    settingsManager.setToolsetPreference(agent.id, "codex", conversation.id);
    settingsManager.setClientPreferences(agent.id, conversation.id, {
      toolset: { include: ["AskUserQuestion"] },
    });
    const parent = await prepareToolExecutionContextForScope({
      agentId: agent.id,
      conversationId: conversation.id,
    });
    expect(parent.preparedToolContext.loadedToolNames).toContain(
      "AskUserQuestion",
    );
    const fork = await forkParentConversation({
      backend,
      parentAgentId: agent.id,
      parentConversationId: conversation.id,
      config: {
        name: "fork",
        description: "Fork the parent conversation",
        systemPrompt: "",
        allowedTools: "all",
        recommendedModel: "inherit",
        recommendedModelSource: "builtin",
        skills: [],
        fork: true,
        launchProfile: "default",
      },
    });
    expect(fork.id).not.toBe(conversation.id);
    expect(settingsManager.getToolsetPreference(agent.id, fork.id)).toBe(
      "codex",
    );
    expect(settingsManager.getClientPreferences(agent.id, fork.id)).toEqual({});
    const child = await prepareToolExecutionContextForScope({
      agentId: agent.id,
      conversationId: fork.id,
    });
    expect(child.preparedToolContext.loadedToolNames).not.toContain(
      "AskUserQuestion",
    );
    // A subsequent parent turn omits client_toolset and still uses its defaults.
    const nextParent = await prepareToolExecutionContextForScope({
      agentId: agent.id,
      conversationId: conversation.id,
    });
    expect(nextParent.preparedToolContext.loadedToolNames).toEqual(
      parent.preparedToolContext.loadedToolNames,
    );
    expect(nextParent.preparedToolContext.loadedToolNames).toContain(
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
