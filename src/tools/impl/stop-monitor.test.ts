import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import type { MonitorStopCommand } from "@/types/task-control-protocol";
import {
  clearPendingMessages,
  setMessageQueueAdder,
} from "@/utils/message-queue-bridge";
import { monitor } from "./monitor";
import { MonitorCancellationStore } from "./monitor-cancellation-store";
import {
  type BackgroundProcess,
  backgroundProcesses,
  clearBackgroundProcessCleanup,
  getNextMonitorId,
} from "./process_manager";
import { UserMonitorStopper } from "./stop-monitor";
import { task_stop } from "./task-stop";

let dir: string;
let store: MonitorCancellationStore;
let stopper: UserMonitorStopper;
const scope = {
  agent_id: "agent-a",
  conversation_id: "conv-a",
  acting_user_id: "user-a",
};
function command(processId: string, runtime = scope): MonitorStopCommand {
  return {
    type: "monitor_stop",
    request_id: "req-1",
    runtime,
    process_id: processId,
  };
}
function fakeMonitor(
  id: string,
  kill: () => void = () => undefined,
): BackgroundProcess {
  const process: BackgroundProcess = {
    kind: "monitor",
    description: "CI results",
    process: { kill },
    command: "sleep 60",
    stdout: [],
    stderr: [],
    status: "running",
    exitCode: null,
    lastReadIndex: { stdout: 0, stderr: 0 },
    runtimeScope: { agentId: "agent-a", conversationId: "conv-a" },
  };
  backgroundProcesses.set(id, process);
  return process;
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "monitor-cancel-test-"));
  store = new MonitorCancellationStore(join(dir, "receipts"));
  stopper = new UserMonitorStopper(store);
});
afterEach(() => {
  for (const [id, process] of backgroundProcesses) {
    process.completionNotificationSuppressed = true;
    try {
      process.process.kill("SIGKILL");
    } catch {
      /* gone */
    }
    clearBackgroundProcessCleanup(id);
  }
  backgroundProcesses.clear();
  setMessageQueueAdder(null);
  clearPendingMessages();
  rmSync(dir, { recursive: true, force: true });
});

describe("UserMonitorStopper", () => {
  test("uses restart-safe IDs and stops only the scoped Monitor", async () => {
    const id = getNextMonitorId();
    expect(id).toMatch(/^monitor_[0-9a-f-]{36}$/);
    expect(getNextMonitorId()).not.toBe(id);
    const process = fakeMonitor(id);
    const other = fakeMonitor("other");
    const wrong = await stopper.stop(
      command(id, { ...scope, conversation_id: "other" }),
    );
    expect(wrong.success).toBe(false);
    expect(process.status).toBe("running");
    expect(store.read(id)).toBeNull();
    const response = await stopper.stop(command(id));
    expect(response).toMatchObject({ success: true, stopped: true });
    expect(other.status).toBe("running");
    expect(store.read(id)).toMatchObject({
      state: "stopped",
      runtime: scope,
      description: "CI results",
    });
    const [retry, second] = await Promise.all([
      stopper.stop(command(id)),
      stopper.stop(command(id)),
    ]);
    expect(retry).toMatchObject({ success: true, stopped: false });
    expect(second).toMatchObject({ success: true, stopped: false });
    expect(store.list()).toHaveLength(1);
    expect(
      await new UserMonitorStopper(
        new MonitorCancellationStore(store.directory),
      ).stop(command(id)),
    ).toMatchObject({ success: true, stopped: false });
  });

  test("rejects unknown tasks and non-Monitors", async () => {
    expect((await stopper.stop(command("unknown"))).success).toBe(false);
    const process = fakeMonitor("bash-1");
    delete process.kind;
    expect((await stopper.stop(command("bash-1"))).success).toBe(false);
    expect(process.status).toBe("running");
    expect(store.list()).toEqual([]);
  });

  test("a failed initial persistence leaves the source running", async () => {
    writeFileSync(join(dir, "not-a-directory"), "file");
    const failing = new UserMonitorStopper(
      new MonitorCancellationStore(join(dir, "not-a-directory")),
    );
    const process = fakeMonitor("monitor-fail");
    expect((await failing.stop(command("monitor-fail"))).success).toBe(false);
    expect(process.status).toBe("running");
  });

  test("does not record a failed stop as a confirmed cancellation", async () => {
    const process = fakeMonitor("monitor-fail", () => {
      throw new Error("stop failed");
    });
    expect((await stopper.stop(command("monitor-fail"))).success).toBe(false);
    expect(store.read("monitor-fail")?.state).toBe("failed");
    expect(process.status).toBe("running");
  });

  test("keeps durable intent when confirming the successful stop fails", async () => {
    const originalWrite = store.write.bind(store);
    store.write = (receipt) => {
      if (receipt.state === "stopped") throw new Error("disk full");
      originalWrite(receipt);
    };
    fakeMonitor("monitor-1");
    expect(await stopper.stop(command("monitor-1"))).toMatchObject({
      success: false,
      stopped: true,
    });
    expect(
      new MonitorCancellationStore(store.directory).read("monitor-1")?.state,
    ).toBe("intent");
  });

  test("stops a real command source and suppresses its ordinary completion", async () => {
    const notices: string[] = [];
    setMessageQueueAdder((message) => notices.push(message.text));
    const file = join(dir, "child.js");
    writeFileSync(file, "setInterval(() => {}, 1000)");
    const result = await monitor({
      description: "Command events",
      persistent: true,
      command: `${JSON.stringify(process.execPath)} ${JSON.stringify(file)}`,
      parentScope: {
        agentId: scope.agent_id,
        conversationId: scope.conversation_id,
      },
    });
    expect(await stopper.stop(command(result.taskId))).toMatchObject({
      success: true,
      stopped: true,
    });
    await Bun.sleep(50);
    expect(backgroundProcesses.get(result.taskId)?.status).toBe("failed");
    expect(notices).toEqual([]);
  });

  test("stops a real WebSocket source; agent TaskStop stays silent", async () => {
    const notices: string[] = [];
    setMessageQueueAdder((message) => notices.push(message.text));
    const server = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("No server port");
      const result = await monitor({
        description: "Socket events",
        persistent: true,
        ws: { url: `ws://127.0.0.1:${address.port}` },
        parentScope: {
          agentId: scope.agent_id,
          conversationId: scope.conversation_id,
        },
      });
      expect(await stopper.stop(command(result.taskId))).toMatchObject({
        success: true,
        stopped: true,
      });
      const silent = await monitor({
        description: "Agent-owned stop",
        persistent: true,
        ws: { url: `ws://127.0.0.1:${address.port}` },
        parentScope: {
          agentId: scope.agent_id,
          conversationId: scope.conversation_id,
        },
      });
      expect(await task_stop({ task_id: silent.taskId })).toEqual({
        killed: true,
      });
      expect(store.read(silent.taskId)).toBeNull();
      await Bun.sleep(50);
      expect(notices).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
