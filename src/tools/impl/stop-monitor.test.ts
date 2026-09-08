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
import {
  type BackgroundProcess,
  backgroundProcesses,
  clearBackgroundProcessCleanup,
  getNextMonitorId,
} from "./process_manager";
import { stopMonitor } from "./stop-monitor";
import { task_stop } from "./task-stop";

let dir: string;
let notices: import("@/utils/message-queue-bridge").QueuedMessage[];
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
  notices = [];
  setMessageQueueAdder((message) => notices.push(message));
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

describe("stopMonitor", () => {
  test("uses restart-safe IDs and stops only the scoped Monitor", async () => {
    const id = getNextMonitorId();
    expect(id).toMatch(/^monitor_[0-9a-f-]{36}$/);
    expect(getNextMonitorId()).not.toBe(id);
    const process = fakeMonitor(id);
    const other = fakeMonitor("other");
    const wrong = await stopMonitor(
      command(id, { ...scope, conversation_id: "other" }),
    );
    expect(wrong.success).toBe(false);
    expect(process.status).toBe("running");
    expect(notices).toEqual([]);
    const response = await stopMonitor(command(id));
    expect(response).toMatchObject({ success: true, stopped: true });
    expect(other.status).toBe("running");
    expect(notices[0]).toMatchObject({
      kind: "task_notification",
      agentId: scope.agent_id,
      conversationId: scope.conversation_id,
      actingUserId: scope.acting_user_id,
    });
    const [retry, second] = await Promise.all([
      stopMonitor(command(id)),
      stopMonitor(command(id)),
    ]);
    expect(retry).toMatchObject({ success: true, stopped: false });
    expect(second).toMatchObject({ success: true, stopped: false });
    expect(notices).toHaveLength(1);
  });

  test("rejects unknown tasks and non-Monitors", async () => {
    expect((await stopMonitor(command("unknown"))).success).toBe(false);
    const process = fakeMonitor("bash-1");
    delete process.kind;
    expect((await stopMonitor(command("bash-1"))).success).toBe(false);
    expect(process.status).toBe("running");
    expect(notices).toEqual([]);
  });

  test("concurrent stop requests enqueue only one notification", async () => {
    let killed = 0;
    fakeMonitor("monitor-double", () => {
      killed++;
    });
    const responses = await Promise.all([
      stopMonitor(command("monitor-double")),
      stopMonitor({ ...command("monitor-double"), request_id: "req-2" }),
    ]);
    expect(responses.every((response) => response.success)).toBe(true);
    expect(responses.filter((response) => response.stopped)).toHaveLength(1);
    expect(killed).toBe(1);
    expect(notices).toHaveLength(1);
  });

  test("does not notify the agent when stopping fails", async () => {
    const process = fakeMonitor("monitor-fail", () => {
      throw new Error("stop failed");
    });
    expect((await stopMonitor(command("monitor-fail"))).success).toBe(false);
    expect(notices).toEqual([]);
    expect(process.status).toBe("running");
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
    expect(await stopMonitor(command(result.taskId))).toMatchObject({
      success: true,
      stopped: true,
    });
    await Bun.sleep(50);
    expect(backgroundProcesses.get(result.taskId)?.status).toBe("failed");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("The user cancelled this Monitor.");
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
      expect(await stopMonitor(command(result.taskId))).toMatchObject({
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
      await Bun.sleep(50);
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain(result.taskId);
      expect(notices[0]).not.toContain(silent.taskId);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
