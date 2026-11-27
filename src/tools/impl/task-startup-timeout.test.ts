import {
  afterAll,
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
import { clearAllSubagents } from "@/agent/subagent-state";
import { clearSubagentConfigCache } from "@/agent/subagents";
import { __testSetBackend, type Backend } from "@/backend";
import { runWithRuntimeContext } from "@/runtime-context";
import { settingsManager } from "@/settings-manager";
import { backgroundTasks } from "./process_manager";

const originalMetadata = { ...(await import("@/backend/api/metadata")) };
const originalProcess = {
  ...(await import("@/agent/subagents/subagent-process")),
};

mock.module("@/backend/api/metadata", () => ({
  getBillingTier: async () => null,
}));
const spawnProcess = mock(
  (_command: string, _args: string[], options: { signal?: AbortSignal }) => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
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
  spawnManagedWorkloadProcess: spawnProcess,
  killWindowsProcessTree: async () => {},
}));
const { launchSubagent } = await import("./task");
const { task_stop } = await import("./task-stop");

const originalHome = process.env.HOME;
const originalScratchpad = process.env.LETTA_SCRATCHPAD;
let testHome: string;

beforeEach(async () => {
  await settingsManager.reset();
  testHome = mkdtempSync(join(tmpdir(), "task-startup-timeout-"));
  process.env.HOME = testHome;
  process.env.LETTA_SCRATCHPAD = testHome;
  await settingsManager.initialize();
  spyOn(settingsManager, "getSettingsWithSecureTokens").mockImplementation(
    async () => settingsManager.getSettings(),
  );
  spawnProcess.mockClear();
  clearSubagentConfigCache();
  __testSetBackend({
    capabilities: { localMemfs: false },
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

afterAll(() => {
  mock.module("@/backend/api/metadata", () => originalMetadata);
  mock.module("@/agent/subagents/subagent-process", () => originalProcess);
});

describe("background startup deadline", () => {
  test("returns a receipt when the child never publishes a link", async () => {
    const started = Date.now();
    const receipt = await runWithRuntimeContext(
      { workingDirectory: testHome },
      () =>
        launchSubagent(
          {
            harness: "letta",
            prompt: "Work",
            description: "Stalled startup",
            fork_context: false,
          },
          undefined,
          50,
        ),
    );
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    expect(receipt).toMatchObject({
      success: true,
      agent_id: null,
      conversation_id: null,
    });
    expect(spawnProcess).toHaveBeenCalledTimes(1);
    if (!receipt.success) throw new Error(receipt.error);
    const background = backgroundTasks.get(receipt.task_id);
    expect(background?.status).toBe("running");
    expect(background?.abortController?.signal.aborted).toBe(false);
    await task_stop({ task_id: receipt.task_id });
  }, 2000);

  test("aborting a stalled startup ends the wait before its deadline", async () => {
    const controller = new AbortController();
    const reason = new Error("Startup cancelled");
    const launched = runWithRuntimeContext({ workingDirectory: testHome }, () =>
      launchSubagent({
        harness: "letta",
        prompt: "Work",
        description: "Stalled startup",
        fork_context: false,
        signal: controller.signal,
      }),
    );
    const outcome = launched.catch((error: unknown) => error);
    while (!spawnProcess.mock.calls.length) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    controller.abort(reason);
    expect(await outcome).toBe(reason);
    const [background] = backgroundTasks.values();
    expect(background?.abortController?.signal.aborted).toBe(true);
    await background?.completion;
  }, 2000);
});
