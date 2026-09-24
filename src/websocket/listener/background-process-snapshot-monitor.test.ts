import { afterEach, describe, expect, test } from "bun:test";
import type { TaskNotificationQueueItem } from "@/queue/queue-runtime";
import {
  type BackgroundProcess,
  backgroundProcesses,
} from "@/tools/impl/process_manager";
import {
  buildBackgroundProcessSnapshot,
  pendingRequestClientMessageIds,
} from "./background-process-snapshot";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { createRuntime } from "./lifecycle";

afterEach(() => {
  backgroundProcesses.clear();
});

describe("background process snapshots", () => {
  test("reports only running monitors in their owning runtime", () => {
    backgroundProcesses.set("monitor_1", {
      process: { kill: () => {} },
      command: "tail -f app.log",
      stdout: [],
      stderr: [],
      status: "running",
      exitCode: null,
      startTime: new Date(1234),
      runtimeScope: { agentId: "agent-a", conversationId: "conv-a" },
      kind: "monitor",
      description: "application errors",
      monitorSource: "command",
      persistent: true,
    });
    backgroundProcesses.set("monitor_2", {
      process: { kill: () => {} },
      command: "wss://events.example.com",
      stdout: [],
      stderr: [],
      status: "completed",
      exitCode: 1000,
      startTime: new Date(5678),
      runtimeScope: { agentId: "agent-a", conversationId: "conv-a" },
      kind: "monitor",
      description: "deploy events",
      monitorSource: "websocket",
      persistent: false,
    });

    expect(buildBackgroundProcessSnapshot("agent-a", "conv-a")).toEqual([
      {
        process_id: "monitor_1",
        kind: "monitor",
        description: "application errors",
        source: "command",
        started_at_ms: 1234,
        status: "running",
        persistent: true,
      },
    ]);
    expect(buildBackgroundProcessSnapshot("agent-b", "conv-a")).toEqual([]);
  });

  test("keeps a yielded command pending across its notification handoff", () => {
    const runtime = getOrCreateScopedRuntime(
      createRuntime(),
      "agent-a",
      "conv-a",
    );
    const pending = () =>
      pendingRequestClientMessageIds("agent-a", "conv-a", runtime);
    backgroundProcesses.set("bash-yielded", {
      process: { kill: () => {} },
      command: "slow check",
      status: "running",
      exitCode: null,
      runtimeScope: { agentId: "agent-a", conversationId: "conv-a" },
      originClientMessageIds: ["cm-original"],
    });
    backgroundProcesses.set("bash-server", {
      process: { kill: () => {} },
      command: "dev server",
      status: "running",
      exitCode: null,
      runtimeScope: { agentId: "agent-a", conversationId: "conv-a" },
    });
    expect(pending()).toEqual(["cm-original"]);
    const yielded = backgroundProcesses.get("bash-yielded");
    if (!yielded) throw new Error("missing yielded process");
    yielded.status = "completed";
    runtime.queueRuntime.enqueue({
      kind: "task_notification",
      source: "task_notification",
      text: "done",
      agentId: "agent-a",
      conversationId: "conv-a",
      originClientMessageIds: ["cm-original"],
    } as Omit<TaskNotificationQueueItem, "id" | "enqueuedAt">);
    expect(pending()).toEqual(["cm-original"]);
    runtime.queueRuntime.consumeItems(1);
    runtime.activeTurnClientMessageIds = ["cm-original"];
    expect(pending()).toEqual(["cm-original"]);
    runtime.activeTurnClientMessageIds = [];
    expect(pending()).toEqual([]);
  });

  test("reports running workflows separately from Bash processes", () => {
    backgroundProcesses.set("workflow_1", {
      process: { kill: () => {} },
      command: "workflow review-changes",
      stdout: [],
      stderr: [],
      status: "running",
      exitCode: null,
      lastReadIndex: { stdout: 0, stderr: 0 },
      startTime: new Date(5678),
      runtimeScope: { agentId: "agent-a", conversationId: "conv-a" },
      kind: "workflow",
      description: "Review changed files across dimensions",
    } as BackgroundProcess);

    expect(buildBackgroundProcessSnapshot("agent-a", "conv-a")).toEqual([
      {
        process_id: "workflow_1",
        kind: "workflow",
        description: "Review changed files across dimensions",
        started_at_ms: 5678,
        status: "running",
      },
    ]);
  });
});
