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
import { runWithRuntimeContext } from "@/runtime-context";
import { settingsManager } from "@/settings-manager";
import { backgroundTasks } from "./process_manager";

// External coding workers with fork_context. Replace discovery and the
// child-process boundary only; task(), the selection logic, and the transcript
// rendering run for real. Runs isolated via
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

// External workers: keep the real module, replace only the process launch and
// the remote hand-off so the prompt each would receive can be observed.
const workerPrompts: string[] = [];
const realExternal = await import("./external-coding-agent");
mock.module("./external-coding-agent", () => ({
  ...realExternal,
  runExternalCodingAgent: async (options: {
    prompt: string;
    onStarted?: (agentId: string) => void;
  }) => {
    workerPrompts.push(options.prompt);
    options.onStarted?.("codex_00000000-0000-0000-0000-000000000000");
    return new Promise<SubagentResult>(() => {});
  },
}));
const remoteLaunches: Array<{ prompt: string; forkContext?: boolean }> = [];
const realRemote = await import("./remote-external-coding-agent");
mock.module("./remote-external-coding-agent", () => ({
  ...realRemote,
  launchRemoteExternalCodingAgent: async (launch: {
    prompt: string;
    forkContext?: boolean;
  }) => {
    remoteLaunches.push(launch);
    return { success: true, task_id: "t", output_file: "o", agent_id: null };
  },
}));

const { task } = await import("./task");
const forkConversation = mock(async () => ({ id: "conv-forked-child" }));
const retrieveAgent = mock(async () => ({ model: "anthropic/test-model" }));
const olderMessage = `OLDER ${"x".repeat(50_000)}`;
const parentMessages = [
  {
    id: "older",
    date: "",
    message_type: "user_message",
    content: olderMessage,
  },
  {
    id: "m1",
    date: "",
    message_type: "user_message",
    content: "Use Postgres.",
  },
  { id: "m2", date: "", message_type: "assistant_message", content: "Ok." },
];
const listConversationMessages = mock(async () => ({
  getPaginatedItems: () => [...parentMessages].reverse(),
}));
let scratchpad: string;
let previousHome: string | undefined;
let previousScratchpad: string | undefined;

beforeEach(async () => {
  spawn.mockClear();
  spawnCalls.length = 0;
  forkConversation.mockClear();
  listConversationMessages.mockClear();
  workerPrompts.length = 0;
  remoteLaunches.length = 0;
  __testSetBackend({
    capabilities: { environmentRouting: true },
    forkConversation,
    retrieveAgent,
    listConversationMessages,
  } as unknown as Backend);
  setCurrentAgentId("agent-parent");
  scratchpad = mkdtempSync(join(tmpdir(), "task-external-fork-"));
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

describe("fork_context for external coding workers", () => {
  test("a local codex worker forks by default and gets recent history and the task", async () => {
    const result = await runWithRuntimeContext(
      { workingDirectory: scratchpad },
      () =>
        task({
          ...brief,
          harness: "codex",
          mcp: { inherit: false },
        }),
    );

    expect(result).toContain("Task running in background");
    expect(forkConversation).not.toHaveBeenCalled();
    expect(workerPrompts).toHaveLength(1);
    const prompt = workerPrompts[0] as string;
    const metadata = JSON.parse(
      prompt.split("<parent_history>\n")[1]?.split("\n")[0] as string,
    );
    expect(metadata.shown).toBe(3);
    expect(metadata).not.toHaveProperty("full_history_path");
    expect(prompt).toContain("Use Postgres.");
    expect(prompt).toEndWith("Task:\nDo the work");
  });

  test("an unforked codex worker gets the prompt verbatim", async () => {
    await task({
      ...brief,
      harness: "codex",
      fork_context: false,
      mcp: { inherit: false },
    });

    expect(listConversationMessages).not.toHaveBeenCalled();
    expect(workerPrompts).toEqual(["Do the work"]);
  });

  test("a remote worker forks by default and prepares history at the destination, not the caller", async () => {
    await task({
      ...brief,
      harness: "claude-code",
      computer: "office-mac",
    });

    expect(remoteLaunches).toHaveLength(1);
    expect(remoteLaunches[0]?.prompt).toBe(brief.prompt);
    expect(remoteLaunches[0]?.forkContext).toBe(true);
    expect(listConversationMessages).not.toHaveBeenCalled();
  });

  test("a forked external worker ignores the default computer", async () => {
    process.env.LETTA_DEFAULT_SUBAGENT_COMPUTER = "cloud";
    try {
      await task({
        ...brief,
        harness: "codex",
        fork_context: true,
        mcp: { inherit: false },
      });
    } finally {
      delete process.env.LETTA_DEFAULT_SUBAGENT_COMPUTER;
    }

    expect(remoteLaunches).toHaveLength(0);
    expect(workerPrompts).toHaveLength(1);
  });
});
