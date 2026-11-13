import { afterEach, expect, mock, spyOn, test } from "bun:test";
import type {
  AppServerClient,
  AppServerMessageHandler,
} from "@/app-server-client";
import {
  type EnvironmentConnection,
  resolveEnvironmentConnectionId,
} from "@/backend/api/environments";
import { telemetry } from "@/telemetry";
import type {
  LaunchSubagentCommand,
  SubagentMessageCommand,
} from "@/types/subagent-protocol";
import { toSubagentLaunchArgs } from "@/websocket/listener/subagent-protocol-inbound";
import {
  launchRemoteExternalCodingAgent,
  type SpawnRemoteFollowTask,
  sendRemoteExternalCodingAgentMessage,
} from "./remote-external-coding-agent";
import { shouldForkTaskContext } from "./task-agent-selection";

const parentScope = { agentId: "agent-parent", conversationId: "conv-parent" };
const PARENT_READ_DENIED =
  "Failed to read the parent conversation: 403 This conversation is private. Prompt: secret plan";

function environment(externalForkContext: boolean): EnvironmentConnection {
  return {
    id: "env-test",
    connectionId: "conn-test",
    deviceId: "device-test",
    connectionName: "worker",
    organizationId: "org-test",
    podId: "pod-test",
    connectedAt: 1,
    lastHeartbeat: 1,
    lastSeenAt: 1,
    firstSeenAt: 1,
    metadata: {
      launch_subagent_notify_caller: true,
      external_fork_context: externalForkContext,
      subagent_message: true,
    },
  };
}

/** A computer that records each launch and refuses it the way a destination does. */
function refusingComputer(error = PARENT_READ_DENIED) {
  const launches: LaunchSubagentCommand[] = [];
  const messages: SubagentMessageCommand[] = [];
  const client = {
    onMessage: () => () => {},
    onDisconnect: () => () => {},
    sendRaw: () => {},
    close: () => {},
    launchSubagent: async (command: LaunchSubagentCommand) => {
      launches.push(command);
      return {
        type: "launch_subagent_response",
        request_id: command.request_id,
        runtime: command.runtime,
        success: false,
        error,
      };
    },
    sendSubagentMessage: async (command: SubagentMessageCommand) => {
      messages.push(command);
      return {
        type: "subagent_message_response",
        request_id: command.request_id,
        runtime: command.runtime,
        success: false,
        error,
      };
    },
  } as unknown as AppServerClient;
  return { client, launches, messages };
}

function captureTelemetry() {
  spyOn(telemetry, "flush").mockResolvedValue(undefined);
  return spyOn(telemetry, "trackError").mockImplementation(() => {});
}

function launch(
  client: AppServerClient,
  options: {
    forkContext?: boolean;
    externalForkContext?: boolean;
    lettaCodeVersion?: string;
  } = {},
) {
  return launchRemoteExternalCodingAgent(
    {
      type: "claude-code",
      computer: "cloud",
      prompt: "Fix the bug",
      description: "Fix the bug",
      toolCallId: "call-1",
      parentScope,
      forkContext: options.forkContext,
    },
    {
      spawn: () => {
        throw new Error("A refused launch must not start a follow task");
      },
      resolveComputer: async () => ({
        connectionId: "conn-test",
        environment: {
          ...environment(options.externalForkContext ?? true),
          metadata: {
            ...environment(options.externalForkContext ?? true).metadata,
            lettaCodeVersion: options.lettaCodeVersion,
          },
        },
      }),
      connect: async () => client,
    },
  );
}

afterEach(() => mock.restore());

test.each([
  { externalForkContext: true, forkContext: false },
  { externalForkContext: true, forkContext: undefined },
  { externalForkContext: true, forkContext: true },
  { externalForkContext: false, forkContext: false },
])("the destination keeps the caller's fork choice (%j)", async (options) => {
  captureTelemetry();
  const computer = refusingComputer();
  await launch(computer.client, options);
  const wire = computer.launches[0]?.args;
  if (!wire) throw new Error("No launch was sent");
  // The mapping and fork decision the destination listener applies.
  const received = toSubagentLaunchArgs(wire);
  expect(received.harness).toBe("claude-code");
  expect(shouldForkTaskContext(received)).toBe(options.forkContext === true);
});

test("a 0.34.51 listener receives an explicit no-fork launch", async () => {
  captureTelemetry();
  const computer = refusingComputer();
  await launch(computer.client, {
    forkContext: false,
    externalForkContext: false,
    lettaCodeVersion: "0.34.51",
  });
  const wire = computer.launches[0]?.args;
  if (!wire) throw new Error("No launch was sent");
  // Older listeners do not apply today's legacy no-fork mapping.
  expect(wire.fork_context).toBe(false);
  const received = toSubagentLaunchArgs(wire);
  expect(received.harness).toBe("claude-code");
  expect(received.fork_context).toBe(false);
  expect(shouldForkTaskContext(received)).toBe(false);
});

test("a refused launch is reported with only its stage, status, and IDs", async () => {
  const trackError = captureTelemetry();
  const result = await launch(refusingComputer().client);
  expect(result).toEqual({
    success: false,
    error: `Couldn't launch claude-code on cloud: ${PARENT_READ_DENIED}`,
  });
  expect(trackError).toHaveBeenCalledTimes(1);
  const [errorType, message, context, options] = trackError.mock.calls[0] ?? [];
  expect(errorType).toBe("external_worker_launch_failed");
  expect(options).toEqual({ httpStatus: 403, omitDebugLogTail: true });
  expect(JSON.parse(context ?? "")).toEqual({
    stage: "launch_rejected",
    harness: "claude-code",
    computer: "cloud",
    agent_id: "agent-parent",
    conversation_id: "conv-parent",
    tool_call_id: "call-1",
  });
  expect(`${message} ${context}`).not.toContain("secret");
  expect(`${message} ${context}`).not.toContain("private");
});

test("an unreachable computer is reported as a connect failure", async () => {
  const trackError = captureTelemetry();
  const result = await launchRemoteExternalCodingAgent(
    {
      type: "codex",
      computer: "cloud",
      prompt: "Fix the bug",
      description: "Fix the bug",
      parentScope,
    },
    {
      spawn: () => {
        throw new Error("unreachable");
      },
      resolveComputer: async () => ({
        connectionId: "conn-test",
        environment: environment(true),
      }),
      connect: async () => {
        throw new Error("503 Service Unavailable");
      },
    },
  );
  expect(result).toEqual({
    success: false,
    error: "Can't reach cloud: 503 Service Unavailable",
  });
  expect(trackError.mock.calls[0]?.[3]).toMatchObject({ httpStatus: 503 });
  expect(JSON.parse(trackError.mock.calls[0]?.[2] ?? "")).toMatchObject({
    stage: "connect",
    harness: "codex",
    computer: "cloud",
  });
});

test("a refused follow-up is reported and still rejects", async () => {
  const trackError = captureTelemetry();
  const computer = refusingComputer("Worker is gone");
  await expect(
    sendRemoteExternalCodingAgentMessage(
      {
        agentId: "claude_11111111-1111-4111-8111-111111111111@device-test",
        message: "Continue",
        toolCallId: "follow-call",
        parentScope,
      },
      {
        resolveComputer: async () => ({
          connectionId: "conn-test",
          environment: environment(true),
        }),
        connect: async () => computer.client,
      },
    ),
  ).rejects.toThrow("Worker is gone");
  expect(computer.messages).toHaveLength(1);
  expect(JSON.parse(trackError.mock.calls[0]?.[2] ?? "")).toEqual({
    stage: "follow_up",
    harness: "claude-code",
    computer: "device-test",
    agent_id: "agent-parent",
    conversation_id: "conv-parent",
    tool_call_id: "follow-call",
  });
});

test.each([
  "reconnected",
  "unchanged",
  "offline",
  "outdated",
  "retry fails",
] as const)(
  "a lost launch retries only on a replacement listener: %s",
  async (outcome) => {
    const trackError = captureTelemetry();
    const first = refusingComputer();
    const second = refusingComputer();
    let onReplacementMessage: AppServerMessageHandler | undefined;
    spyOn(second.client, "onMessage").mockImplementation((handler) => {
      onReplacementMessage = handler;
      return () => {
        onReplacementMessage = undefined;
      };
    });
    const timeout = new Error("Timed out waiting for launch-subagent");
    spyOn(first.client, "launchSubagent").mockImplementation(
      async (command) => {
        first.launches.push({
          ...command,
          type: "launch_subagent",
          request_id: command.request_id ?? "",
        });
        throw timeout;
      },
    );
    spyOn(second.client, "launchSubagent").mockImplementation(
      async (command) => {
        second.launches.push({
          ...command,
          type: "launch_subagent",
          request_id: command.request_id ?? "",
        });
        if (outcome === "retry fails") throw timeout;
        return {
          type: "launch_subagent_response",
          request_id: command.request_id ?? "",
          runtime: command.runtime,
          success: true,
          task_id: "remote-task",
          output_file: "/remote/out",
          agent_id: null,
          conversation_id: null,
        };
      },
    );
    const closeFirst = spyOn(first.client, "close");
    const closeSecond = spyOn(second.client, "close");
    const resolveComputer = mock(async () => {
      if (resolveComputer.mock.calls.length > 1 && outcome === "offline")
        throw new Error('Computer "worker" is offline');
      const replacement =
        resolveComputer.mock.calls.length > 1 && outcome !== "unchanged";
      const env = environment(replacement);
      env.metadata = {
        ...env.metadata,
        subagent_message: false,
        launch_subagent_notify_caller: !(replacement && outcome === "outdated"),
      };
      return {
        connectionId: replacement ? "conn-b" : "conn-a",
        environment: env,
      };
    });
    const connect = mock(async (id: string) =>
      id === "conn-a" ? first.client : second.client,
    );
    const spawn = mock((_args: Parameters<SpawnRemoteFollowTask>[0]) => ({
      taskId: "follow-task",
      outputFile: "/follow/out",
      subagentId: "follow-subagent",
    }));
    const result = await launchRemoteExternalCodingAgent(
      {
        type: "claude-code",
        computer: "worker",
        prompt: "Fix the bug",
        description: "Fix the bug",
        toolCallId: "call-1",
        parentScope,
      },
      { resolveComputer, connect, spawn },
    );
    expect(resolveComputer).toHaveBeenCalledTimes(2);
    expect(first.launches).toHaveLength(1);
    expect(closeFirst).toHaveBeenCalled();
    const retries = outcome === "reconnected" || outcome === "retry fails";
    expect(second.launches).toHaveLength(retries ? 1 : 0);
    expect(connect.mock.calls.map(([id]) => id)).toEqual(
      retries ? ["conn-a", "conn-b"] : ["conn-a"],
    );
    if (outcome === "reconnected") {
      expect(result.success).toBe(true);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(trackError).not.toHaveBeenCalled();
      expect(closeSecond).not.toHaveBeenCalled();
      expect(second.launches[0]?.request_id).not.toBe(
        first.launches[0]?.request_id,
      );
      expect(second.launches[0]?.tool_call_id).toBe(
        first.launches[0]?.tool_call_id,
      );
      // The replacement's capabilities determine the wire format.
      expect(first.launches[0]?.args.subagent_type).toBe("claude-code");
      expect(second.launches[0]?.args.fork_context).toBe(false);
      onReplacementMessage?.(
        {
          type: "update_subagent_state",
          event_seq: 1,
          emitted_at: new Date().toISOString(),
          idempotency_key: "replacement-completed",
          runtime: {
            agent_id: parentScope.agentId,
            conversation_id: parentScope.conversationId,
          },
          subagents: [
            {
              subagent_id: "remote-worker",
              subagent_type: "claude-code",
              description: "Fix the bug",
              status: "completed",
              agent_url: null,
              tool_call_id: "call-1",
              start_time: 0,
              tool_calls: [],
              total_tokens: 0,
              duration_ms: 1,
              result: "Replacement worker finished",
            },
          ],
        },
        "control",
      );
      const follow = spawn.mock.calls[0]?.[0].deps.spawnSubagentImpl;
      if (!follow) throw new Error("No follower spawned");
      const completed = await follow(
        "claude-code",
        "Fix the bug",
        undefined,
        "follow-subagent",
      );
      expect(completed).toMatchObject({
        success: true,
        report: "Replacement worker finished",
      });
      expect(closeSecond).toHaveBeenCalled();
    } else {
      expect(result.success).toBe(false);
      expect(spawn).not.toHaveBeenCalled();
      expect(trackError).toHaveBeenCalledTimes(1);
      expect(JSON.parse(trackError.mock.calls[0]?.[2] ?? "")).toMatchObject({
        stage: "launch_request",
      });
      if (!result.success && outcome === "offline")
        expect(result.error).toContain("worker disconnected during the launch");
      if (outcome === "retry fails") expect(closeSecond).toHaveBeenCalled();
    }
  },
);

test("an offline computer reports its resolution code without its name or error text", async () => {
  const trackError = captureTelemetry();
  const computer = "Developer's computer";
  const result = await launchRemoteExternalCodingAgent(
    {
      type: "codex",
      computer,
      prompt: "Fix the bug",
      description: "Fix the bug",
      parentScope,
    },
    {
      spawn: () => {
        throw new Error("An offline computer must not start a follow task");
      },
      resolveComputer: (selector) =>
        resolveEnvironmentConnectionId(selector, async () => ({
          connections: [{ ...environment(true), connectionName: computer }],
          hasNextPage: false,
        })),
    },
  );
  expect(result.success).toBe(false);
  if (!result.success)
    expect(result.error).toContain(`Computer "${computer}" is offline.`);
  expect(trackError).toHaveBeenCalledTimes(1);
  const [, message, context] = trackError.mock.calls[0] ?? [];
  expect(message).toBe("External worker launch failed");
  expect(JSON.parse(context ?? "")).toEqual({
    stage: "resolve_computer",
    harness: "codex",
    error_code: "computer_offline",
    agent_id: "agent-parent",
    conversation_id: "conv-parent",
  });
});
