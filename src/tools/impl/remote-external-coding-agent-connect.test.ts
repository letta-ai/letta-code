import { expect, mock, test } from "bun:test";
import type { AppServerClient } from "@/app-server-client";
import type { EnvironmentConnection } from "@/backend/api/environments";
import { launchRemoteExternalCodingAgent } from "./remote-external-coding-agent";

test.each([522, 401])("initial HTTP %i connection failure", async (status) => {
  const launchSubagent = mock(async () => ({
    success: true,
    task_id: "remote-task",
    output_file: "/tmp/remote-output",
    agent_id: "session-test",
  }));
  const client = {
    onMessage: () => () => {},
    onDisconnect: () => () => {},
    launchSubagent,
    close: () => {},
  } as unknown as AppServerClient;
  const connect = mock(async () => {
    if (connect.mock.calls.length === 1)
      throw new Error(`App-server WebSocket failed to open: HTTP ${status}`);
    return client;
  });
  const result = await launchRemoteExternalCodingAgent(
    {
      type: "claude-code",
      computer: "worker",
      prompt: "Fix the bug",
      description: "Fix the bug",
      parentScope: { agentId: "agent-parent", conversationId: "conv-parent" },
    },
    {
      connect,
      resolveComputer: async () => ({
        connectionId: "connection-test",
        environment: {
          deviceId: "device-test",
          metadata: { launch_subagent_notify_caller: true },
        } as EnvironmentConnection,
      }),
      spawn: () => ({
        taskId: "task-test",
        outputFile: "/tmp/output",
        subagentId: "subagent-test",
      }),
    },
  );
  expect(connect).toHaveBeenCalledTimes(status === 522 ? 2 : 1);
  expect(launchSubagent).toHaveBeenCalledTimes(status === 522 ? 1 : 0);
  if (status === 401)
    expect(result).toEqual({
      success: false,
      error:
        "Can't reach worker: App-server WebSocket failed to open: HTTP 401",
    });
});
