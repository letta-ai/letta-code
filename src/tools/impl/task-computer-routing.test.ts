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
import { backgroundTasks } from "./process_manager";

// Replace discovery and the child-process boundary, not task() or its background
// helper. This file runs in a fresh process via isolated-unit-tests.json.
const config: SubagentConfig = {
  name: "general-purpose",
  description: "Routing fixture",
  systemPrompt: "Routing fixture",
  allowedTools: "all",
  recommendedModel: "inherit",
  skills: [],
  fork: false,
  launchProfile: "default",
};
mock.module("@/agent/subagents", () => ({
  getAllSubagentConfigs: async () => ({
    "general-purpose": config,
    fork: { ...config, name: "fork", fork: true },
  }),
  clearSubagentConfigCache: () => {},
  discoverSubagents: async () => ({ subagents: [], errors: [] }),
}));

const spawn = mock((...args: Parameters<typeof spawnSubagent>) => {
  updateSubagent(args[3] as string, {
    agentId: "agent-routing-child",
    agentURL: "https://example.invalid/agent-routing-child",
  });
  // Model a still-running child. No timers, completion hooks, or remote calls
  // are needed to observe the launch contract; afterEach clears its local state.
  return new Promise<SubagentResult>(() => {});
});
mock.module("@/agent/subagents/manager", () => ({ spawnSubagent: spawn }));

const { task } = await import("./task");
const forkConversation = mock(async () => {
  throw new Error("Unexpected fork of parent conversation");
});
const retrieveAgent = mock(async () => ({ model: "anthropic/test-model" }));
const capabilities = { environmentRouting: true };
let scratchpad: string;
let previousScratchpad: string | undefined;

beforeEach(() => {
  spawn.mockClear();
  forkConversation.mockClear();
  retrieveAgent.mockClear();
  capabilities.environmentRouting = true;
  __testSetBackend({
    capabilities,
    forkConversation,
    retrieveAgent,
  } as unknown as Backend);
  setCurrentAgentId("agent-routing-parent");
  previousScratchpad = process.env.LETTA_SCRATCHPAD;
  scratchpad = mkdtempSync(join(tmpdir(), "task-computer-routing-"));
  process.env.LETTA_SCRATCHPAD = scratchpad;
});

afterEach(() => {
  backgroundTasks.clear();
  clearAllSubagents();
  setCurrentAgentId(null);
  __testSetBackend(null);
  if (previousScratchpad === undefined) {
    delete process.env.LETTA_SCRATCHPAD;
  } else {
    process.env.LETTA_SCRATCHPAD = previousScratchpad;
  }
  rmSync(scratchpad, { recursive: true, force: true });
});

afterAll(() => {
  mock.restore();
});

const launchArgs = {
  subagent_type: "general-purpose",
  prompt: "Check routing without executing a child",
  description: "Routing contract",
};

describe("task computer routing", () => {
  test("forwards a whitespace-padded selector trimmed to the child", async () => {
    const result = await task({ ...launchArgs, computer: " \t office-mac \n" });

    expect(result).toContain("Task running in background with task ID:");
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0]?.[14]).toBe("office-mac");
    expect(backgroundTasks.size).toBe(1);
  });

  test.each(["general-purpose", "fork"])(
    "rejects a non-routing backend before spawning or forking %s",
    async (subagent_type) => {
      capabilities.environmentRouting = false;
      const result = await task({
        ...launchArgs,
        subagent_type,
        computer: " office-mac ",
      });

      expect(result).toContain(
        "Error: The computer option requires a Letta Cloud backend.",
      );
      expect(result).toContain("omit the computer field");
      expect(spawn).not.toHaveBeenCalled();
      expect(forkConversation).not.toHaveBeenCalled();
      expect(retrieveAgent).not.toHaveBeenCalled();
      expect(backgroundTasks.size).toBe(0);
    },
  );

  for (const environmentRouting of [true, false]) {
    test.each([undefined, "", " \t\n "])(
      `keeps the default computer for %j (routing=${environmentRouting})`,
      async (computer) => {
        capabilities.environmentRouting = environmentRouting;
        const result = await task({
          ...launchArgs,
          ...(computer === undefined ? {} : { computer }),
        });

        expect(result).toContain("Task running in background with task ID:");
        expect(spawn).toHaveBeenCalledTimes(1);
        expect(spawn.mock.calls[0]?.[14]).toBeUndefined();
        expect(backgroundTasks.size).toBe(1);
      },
    );
  }
});
