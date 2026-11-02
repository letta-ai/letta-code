import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setCurrentAgentId } from "@/agent/context";
import { clearAllSubagents, updateSubagent } from "@/agent/subagent-state";
import type { SubagentConfig, SubagentResult } from "@/agent/subagents";
import type { spawnSubagent } from "@/agent/subagents/manager";
import { __testSetBackend, type Backend } from "@/backend";
import { settingsManager } from "@/settings-manager";
import { backgroundTasks } from "./process_manager";

// Replace discovery and the child-process boundary only; task(), the selection
// logic, and the fork helper run for real. Runs isolated via
// isolated-unit-tests.json because of the module mocks.
const base: SubagentConfig = {
  name: "general-purpose",
  description: "Fixture",
  systemPrompt: "Fixture",
  allowedTools: "all",
  recommendedModel: "inherit",
  skills: [],
  fork: false,
  launchProfile: "default",
};
mock.module("@/agent/subagents", () => ({
  getAllSubagentConfigs: async () => ({
    "general-purpose": base,
    fork: { ...base, name: "fork", fork: true },
    recall: { ...base, name: "recall", fork: true },
    reviewer: { ...base, name: "reviewer" },
  }),
  clearSubagentConfigCache: () => {},
  discoverSubagents: async () => ({ subagents: [], errors: [] }),
}));

interface SpawnCall {
  type: string;
  existingConversationId?: string;
  forkedContext?: boolean;
}
const spawnCalls: SpawnCall[] = [];
const spawn = mock(
  (
    ...[
      type,
      _prompt,
      _userModel,
      subagentId,
      _signal,
      _existingAgentId,
      existingConversationId,
      _maxTurns,
      forkedContext,
    ]: Parameters<typeof spawnSubagent>
  ) => {
    spawnCalls.push({ type, existingConversationId, forkedContext });
    updateSubagent(subagentId, {
      agentId: "agent-child",
      agentURL: "https://example.invalid/agent-child",
    });
    return new Promise<SubagentResult>(() => {});
  },
);
mock.module("@/agent/subagents/manager", () => ({ spawnSubagent: spawn }));

const { task } = await import("./task");
const forkConversation = mock(async () => ({ id: "conv-forked-child" }));
const retrieveAgent = mock(async () => ({ model: "anthropic/test-model" }));
let scratchpad: string;
let previousHome: string | undefined;
let previousScratchpad: string | undefined;

beforeEach(async () => {
  spawn.mockClear();
  spawnCalls.length = 0;
  forkConversation.mockClear();
  __testSetBackend({
    capabilities: { environmentRouting: true },
    forkConversation,
    retrieveAgent,
  } as unknown as Backend);
  setCurrentAgentId("agent-parent");
  scratchpad = mkdtempSync(join(tmpdir(), "task-fork-context-"));
  previousHome = process.env.HOME;
  previousScratchpad = process.env.LETTA_SCRATCHPAD;
  process.env.HOME = scratchpad;
  process.env.LETTA_SCRATCHPAD = scratchpad;
  // The fork helper copies the parent's toolset preference.
  await settingsManager.reset();
  await settingsManager.initialize();
});

afterEach(async () => {
  backgroundTasks.clear();
  clearAllSubagents();
  setCurrentAgentId(null);
  __testSetBackend(null);
  await settingsManager.reset();
  for (const [key, value] of [
    ["HOME", previousHome],
    ["LETTA_SCRATCHPAD", previousScratchpad],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(scratchpad, { recursive: true, force: true });
});

afterAll(() => {
  mock.restore();
});

const brief = { description: "Fork contract", prompt: "Do the work" };

describe("Agent launch selection", () => {
  test("defaults to a fresh letta subagent without forking", async () => {
    const result = await task(brief);

    expect(result).toContain("Task running in background");
    expect(forkConversation).not.toHaveBeenCalled();
    expect(spawnCalls).toEqual([
      {
        type: "general-purpose",
        existingConversationId: undefined,
        forkedContext: false,
      },
    ]);
  });

  test.each([{ harness: "letta", fork_context: true }, { fork_context: true }])(
    "%j forks the parent conversation into the child",
    async (args) => {
      const result = await task({ ...brief, ...args });

      expect(result).toContain("Task running in background");
      expect(forkConversation).toHaveBeenCalledTimes(1);
      expect(spawnCalls).toEqual([
        {
          type: "fork",
          existingConversationId: "conv-forked-child",
          forkedContext: true,
        },
      ]);
    },
  );

  test("a named subagent configured to fork keeps forking", async () => {
    await task({ ...brief, subagent_type: "recall" });

    expect(forkConversation).toHaveBeenCalledTimes(1);
    expect(spawnCalls[0]?.type).toBe("recall");
  });

  test("a named subagent without fork runs fresh", async () => {
    await task({ ...brief, subagent_type: "reviewer" });

    expect(forkConversation).not.toHaveBeenCalled();
    expect(spawnCalls[0]).toMatchObject({ type: "reviewer" });
  });

  test.each([
    [{ fork_context: true, agent_id: "agent-other" }, "fork_context cannot"],
    [{ fork_context: true, conversation_id: "conv-x" }, "fork_context cannot"],
    [{ harness: "codex", fork_context: true }, "not supported for codex"],
    [
      { subagent_type: "reviewer", fork_context: true },
      'fork_context is not supported for subagent_type "reviewer"',
    ],
    [
      { subagent_type: "nope" },
      'Invalid subagent_type "nope". Available subagent types: recall, reviewer',
    ],
    [{ harness: "nope" }, 'Invalid harness "nope"'],
    [{ harness: "codex", subagent_type: "recall" }, "only applies to harness"],
    [{ subagent_type: "fork" }, "use fork_context: true"],
    [
      { subagent_type: "general-purpose" },
      "omit subagent_type for the default",
    ],
    [{ subagent_type: "codex" }, 'pass harness: "codex"'],
    [{ subagent_type: "init" }, "internal subagent type"],
    [{ subagent_type: "reflection" }, "internal subagent type"],
    [{ subagent_type: "memory" }, "internal subagent type"],
    [{ agent_type: "letta" }, "agent_type was renamed to harness"],
    [{ agent_type: "fork" }, "agent_type was renamed to harness"],
  ])("rejects %j before forking or spawning", async (args, message) => {
    const result = await task({ ...brief, ...args });

    expect(result).toStartWith("Error:");
    expect(result).toContain(message);
    expect(forkConversation).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  test("deploying an existing agent accepts harness letta", async () => {
    const result = await task({
      ...brief,
      harness: "letta",
      agent_id: "agent-other",
    });

    expect(result).toContain("Task running in background");
    expect(spawnCalls[0]?.type).toBe("general-purpose");
  });
});
