import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setConversationId, setCurrentAgentId } from "@/agent/context";
import {
  clearAllSubagents,
  getSnapshot as getSubagentSnapshot,
} from "@/agent/subagent-state";
import { clearSubagentConfigCache } from "@/agent/subagents";
import { __testSetBackend, type Backend } from "@/backend";
import { runWithRuntimeContext } from "@/runtime-context";
import { settingsManager } from "@/settings-manager";
import { backgroundTasks } from "./process_manager";

// Keep task(), the manager, and the state store real. Stub backend/credential I/O
// and the child process, which deliberately emits no init event and never exits.
// Module mocks run in a dedicated process via isolated-unit-tests.json.
mock.module("@/backend/api/metadata", () => ({
  getBillingTier: async () => null,
}));
const childInputs: Array<{ args: string[]; prompt: string }> = [];
const spawnProcess = mock(
  (_command: string, args: string[], options: { signal?: AbortSignal }) => {
    const input = { args, prompt: "" };
    childInputs.push(input);
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    child.stdin.on("data", (data) => {
      input.prompt += String(data);
    });
    queueMicrotask(() => child.emit("spawn"));
    return {
      process: child,
      completion: new Promise<{
        exitCode: number | null;
        exitSignal: NodeJS.Signals | null;
      }>((resolve) => {
        options.signal?.addEventListener(
          "abort",
          () => resolve({ exitCode: null, exitSignal: "SIGINT" }),
          { once: true },
        );
      }),
      wasAborted: () => options.signal?.aborted ?? false,
    };
  },
);
mock.module("@/agent/subagents/subagent-process", () => ({
  spawnSubagentProcess: spawnProcess,
}));
const { task, launchSubagent } = await import("./task");
const { task_stop } = await import("./task-stop");

const forkConversation = mock(async () => ({ id: "conv-fork" }));
const originalHome = process.env.HOME;
const originalScratchpad = process.env.LETTA_SCRATCHPAD;
let testHome: string;

beforeEach(async () => {
  await settingsManager.reset();
  testHome = mkdtempSync(join(tmpdir(), "task-fork-receipt-"));
  process.env.HOME = testHome;
  process.env.LETTA_SCRATCHPAD = testHome;
  await settingsManager.initialize();
  spyOn(settingsManager, "getSettingsWithSecureTokens").mockImplementation(
    async () => settingsManager.getSettings(),
  );
  spawnProcess.mockClear();
  childInputs.length = 0;
  forkConversation.mockClear();
  clearSubagentConfigCache();
  __testSetBackend({
    capabilities: { localMemfs: false },
    forkConversation,
    retrieveAgent: async () => ({ name: "Parent", model: "anthropic/test" }),
    retrieveConversation: async (id: string) => ({
      id,
      agent_id: "agent-parent",
      model: "anthropic/test",
    }),
  } as unknown as Backend);
  setCurrentAgentId("agent-parent");
  setConversationId("conv-parent");
});

afterEach(async () => {
  backgroundTasks.clear();
  clearAllSubagents();
  clearSubagentConfigCache();
  setCurrentAgentId(null);
  setConversationId(null);
  __testSetBackend(null);
  mock.restore();
  await settingsManager.reset();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalScratchpad === undefined) delete process.env.LETTA_SCRATCHPAD;
  else process.env.LETTA_SCRATCHPAD = originalScratchpad;
  rmSync(testHome, { recursive: true, force: true });
});

describe("prepared conversation launch", () => {
  test("uses the existing conversation without prompt or tool overrides and remains cancellable", async () => {
    const receipt = await runWithRuntimeContext(
      { workingDirectory: testHome },
      () =>
        launchSubagent({
          subagent_type: "custom",
          conversation_id: "conv-child",
          prompt: "Worker instructions",
          description: "Worker",
          parentScope: {
            agentId: "agent-parent",
            conversationId: "conv-parent",
          },
        }),
    );
    expect(receipt).toMatchObject({
      success: true,
      agent_id: "agent-parent",
      conversation_id: "conv-child",
    });
    if (!receipt.success) throw new Error(receipt.error);
    expect(forkConversation).not.toHaveBeenCalled();
    expect(childInputs[0]?.prompt).toBe("Worker instructions");
    expect(childInputs[0]?.args).toContain("--conv");
    expect(childInputs[0]?.args).toContain("conv-child");
    for (const flag of [
      "--new-agent",
      "--system",
      "--system-custom",
      "--model",
      "--tools",
      "--pre-load-skills",
    ]) {
      expect(childInputs[0]?.args).not.toContain(flag);
    }
    expect(await task_stop({ task_id: receipt.task_id })).toEqual({
      killed: true,
    });
    expect(backgroundTasks.get(receipt.task_id)?.status).toBe("failed");
  });

  test.each([
    { conversation_id: "default" },
    { conversation_id: "conv-parent" },
    { conversation_id: "conv-child", agent_id: "wrong-owner" },
    { conversation_id: "conv-child", model: "do-not-override" },
  ])("rejects invalid prepared launches before spawning %j", async (input) => {
    const result = await launchSubagent({
      subagent_type: "custom",
      ...input,
      prompt: "Work",
      description: "Worker",
    });
    expect(result.success).toBe(false);
    expect(spawnProcess).not.toHaveBeenCalled();
    expect(forkConversation).not.toHaveBeenCalled();
  });
});

describe("fork launch receipt", () => {
  test.each(["fork", "recall"])(
    "%s returns both IDs before the child emits init or completes",
    async (subagent_type) => {
      const receipt = await runWithRuntimeContext(
        { workingDirectory: testHome },
        () =>
          task({
            subagent_type,
            prompt: "Investigate the parent conversation",
            description: "Fork receipt regression",
          }),
      );

      expect(forkConversation).toHaveBeenCalledWith("conv-parent", {
        hidden: true,
        signal: undefined,
      });
      expect(spawnProcess).toHaveBeenCalledTimes(1);
      expect(backgroundTasks.size).toBe(1);
      expect([...backgroundTasks.values()][0]?.status).toBe("running");
      expect(receipt).toContain("Task running in background with task ID:");
      expect(receipt).toContain("\nAgent ID: agent-parent\n");
      expect(receipt).toContain("\nConversation ID: conv-fork\n");
      expect(getSubagentSnapshot().agents).toEqual([
        expect.objectContaining({
          agentId: "agent-parent",
          conversationId: "conv-fork",
          agentURL: expect.stringContaining("conv-fork"),
          status: "running",
        }),
      ]);
    },
    2000,
  );
});
