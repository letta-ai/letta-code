import { afterEach, describe, expect, test } from "bun:test";
import { backgroundProcesses } from "@/tools/impl/process_manager";
import { buildBackgroundProcessSnapshot } from "./background-process-snapshot";

afterEach(() => {
  backgroundProcesses.clear();
});

describe("monitor background process snapshots", () => {
  test("reports only running monitors in their owning runtime", () => {
    backgroundProcesses.set("monitor_1", {
      process: { kill: () => {} },
      command: "tail -f app.log",
      stdout: [],
      stderr: [],
      status: "running",
      exitCode: null,
      lastReadIndex: { stdout: 0, stderr: 0 },
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
      lastReadIndex: { stdout: 0, stderr: 0 },
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
});
