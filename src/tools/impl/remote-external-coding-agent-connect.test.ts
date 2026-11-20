import { expect, mock, test } from "bun:test";
import type { AppServerClient } from "@/app-server-client";
import type { EnvironmentConnection } from "@/backend/api/environments";
import {
  launchRemoteExternalCodingAgent,
  sendRemoteExternalCodingAgentMessage,
} from "./remote-external-coding-agent";

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

test.each(["ECONNRESET", "HTTP 522", "HTTP 401"])(
  "follow-up connection failure: %s",
  async (failure) => {
    const sendSubagentMessage = mock(async () => ({
      success: true,
      delivery: "steered",
    }));
    const close = mock(() => {});
    const client = {
      onMessage: () => () => {},
      onDisconnect: () => () => {},
      sendSubagentMessage,
      close,
    } as unknown as AppServerClient;
    const connect = mock(async () => {
      if (connect.mock.calls.length === 1)
        throw new Error(`App-server WebSocket failed to open: ${failure}`);
      return client;
    });
    const result = sendRemoteExternalCodingAgentMessage(
      {
        agentId: "claude_11111111-1111-4111-8111-111111111111@device-test",
        message: "Continue",
        parentScope: { agentId: "agent-parent", conversationId: "conv-parent" },
      },
      {
        connect,
        resolveComputer: async () => ({
          connectionId: "connection-test",
          environment: {
            metadata: { subagent_message: true },
          } as EnvironmentConnection,
        }),
      },
    );
    if (failure === "HTTP 401") {
      await expect(result).rejects.toThrow(failure);
      expect(connect).toHaveBeenCalledTimes(1);
      expect(sendSubagentMessage).not.toHaveBeenCalled();
    } else {
      expect(await result).toEqual({ delivery: "steered" });
      expect(connect).toHaveBeenCalledTimes(2);
      expect(sendSubagentMessage).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(1);
    }
  },
);
