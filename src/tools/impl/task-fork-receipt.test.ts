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
function fakeChildProcess() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  queueMicrotask(() => child.emit("spawn"));
  return {
    process: child,
    completion: new Promise<never>(() => {}),
    wasAborted: () => false,
  };
}
const spawnProcess = mock(fakeChildProcess);
mock.module("@/agent/subagents/subagent-process", () => ({
  spawnSubagentProcess: spawnProcess,
}));
const { task } = await import("./task");

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
  forkConversation.mockClear();
  clearSubagentConfigCache();
  __testSetBackend({
    capabilities: { localMemfs: false, environmentRouting: true },
    forkConversation,
    retrieveAgent: async () => ({ name: "Parent", model: "anthropic/test" }),
    retrieveConversation: async () => ({ model: "anthropic/test" }),
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

describe("fork launch receipt", () => {
  test("a failed Agent startup rejects dispatch without accepting input or replacing the fork", async () => {
    let exit!: (value: { exitCode: number; exitSignal: null }) => void;
    let spawned!: () => void;
    const spawnGate = new Promise<void>((resolve) => {
      spawned = resolve;
    });
    const child = fakeChildProcess();
    const completion = new Promise<{ exitCode: number; exitSignal: null }>(
      (resolve) => {
        exit = resolve;
      },
    );
    spawnProcess.mockImplementationOnce(() => {
      spawned();
      return { ...child, completion } as ReturnType<typeof fakeChildProcess>;
    });
    const accepted = mock(async () => {});
    const pending = runWithRuntimeContext({ workingDirectory: testHome }, () =>
      task(
        {
          subagent_type: "fork",
          prompt: "Run bound work",
          description: "Failed startup",
          computer: "work-mac",
        },
        {
          beforeStart: async () => ({
            start: true,
            clientMessageId: "slack-thread:conv-fork",
          }),
          onInputAccepted: accepted,
        },
      ),
    );
    await spawnGate;
    child.process.stderr.write("Computer is offline.");
    exit({ exitCode: 1, exitSignal: null });
    await expect(pending).rejects.toThrow("Computer is offline");
    expect(accepted).not.toHaveBeenCalled();
    expect(forkConversation).toHaveBeenCalledTimes(1);
    expect(spawnProcess).toHaveBeenCalledTimes(1);
  });

  test("dispatch waits past the eager fork link for initial enqueue acceptance on the selected computer", async () => {
    let spawned!: () => void;
    const spawnGate = new Promise<void>((resolve) => {
      spawned = resolve;
    });
    let created: ReturnType<typeof fakeChildProcess> | undefined;
    spawnProcess.mockImplementationOnce(() => {
      const value = fakeChildProcess();
      created = value;
      spawned();
      return value;
    });
    let returned = false;
    const pending = runWithRuntimeContext({ workingDirectory: testHome }, () =>
      task(
        {
          subagent_type: "fork",
          prompt: "Run the bound work",
          description: "Thread worker",
          computer: "work-mac",
        },
        {
          beforeStart: async () => ({
            start: true,
            clientMessageId: "slack-thread:conv-fork",
          }),
          onInputAccepted: async (receipt) => {
            expect(receipt.conversation_id).toBe("conv-fork");
          },
        },
      ),
    ).then((value) => {
      returned = true;
      return value;
    });
    await spawnGate;
    expect(getSubagentSnapshot().agents[0]?.conversationId).toBe("conv-fork");
    expect(returned).toBe(false);
    const call = (
      spawnProcess.mock.calls as unknown as Array<
        [string, string[], { env: NodeJS.ProcessEnv }]
      >
    )[0];
    if (!call || !created) throw new Error("Child did not start");
    expect(call[1]).toContain("work-mac");
    expect(call[2].env.LETTA_SUBAGENT_INITIAL_INPUT).toContain(
      "slack-thread:conv-fork",
    );
    const child = created.process;
    child.stdout.write(
      `${JSON.stringify({
        type: "system",
        subtype: "input_accepted",
        receipt: {
          status: "queued",
          agent_id: "agent-parent",
          conversation_id: "conv-fork",
          client_message_id: "slack-thread:conv-fork",
          super_run_id: "super-1",
          workflow_id: "conv-queue-conv-fork",
        },
      })}\n`,
    );
    expect(await pending).toContain("Task running in background");
    expect(returned).toBe(true);
  });

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
