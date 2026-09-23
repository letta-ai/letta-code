import { afterEach, describe, expect, test } from "bun:test";
import {
  type BackgroundProcess,
  backgroundProcesses,
} from "@/tools/impl/process_manager";
import { buildBackgroundProcessSnapshot } from "./background-process-snapshot";

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
