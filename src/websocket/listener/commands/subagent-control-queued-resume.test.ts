import { afterEach, expect, jest, test } from "bun:test";
import { PassThrough } from "node:stream";
import {
  clearAllSubagents,
  registerSubagent,
  updateSubagent,
} from "@/agent/subagent-state";
import type { SubagentResult } from "@/agent/subagents";
import type {
  AppServerClient,
  AppServerMessageHandler,
} from "@/app-server-client";
import { telemetry } from "@/telemetry";
import {
  __resetCodexSessionsForTests,
  sendCodexMessage,
  startCodexTurn,
} from "@/tools/impl/codex-app-server";
import {
  clearNativeSessionCaptureForTests,
  rememberNativeSession,
} from "@/tools/impl/native-session-capture";
import { backgroundTasks } from "@/tools/impl/process_manager";
import { sendRemoteExternalCodingAgentMessage } from "@/tools/impl/remote-external-coding-agent";
import type { SubagentSnapshot } from "@/types/protocol_v2";
import type { SubagentMessageCommand } from "@/types/subagent-protocol";
import { createRuntime } from "@/websocket/listener/lifecycle";
import { createConversationRuntime } from "@/websocket/listener/runtime";
import {
  __resetSubagentControlDedupeForTests,
  handleSubagentMessageCommand,
} from "./subagent-control";

const runtime = { agent_id: "agent-a", conversation_id: "conv-a" };
const parentScope = {
  agentId: runtime.agent_id,
  conversationId: runtime.conversation_id,
};

function remoteClient(
  deliver: (
    command: SubagentMessageCommand,
  ) => ReturnType<typeof handleSubagentMessageCommand>,
) {
  let handler: AppServerMessageHandler | undefined;
  let eventSeq = 0;
  const close = jest.fn();
  const client = {
    close,
    onMessage: (listener: AppServerMessageHandler) => {
      handler = listener;
      return () => {
        handler = undefined;
      };
    },
    onDisconnect: () => () => {},
    sendSubagentMessage: (command: Omit<SubagentMessageCommand, "type">) =>
      deliver({ ...command, type: "subagent_message" }),
  } as unknown as AppServerClient;
  return {
    close,
    snapshot: (subagents: SubagentSnapshot[]) =>
      handler?.(
        {
          type: "update_subagent_state",
          runtime,
          subagents,
          event_seq: ++eventSeq,
          emitted_at: new Date().toISOString(),
          idempotency_key: `snapshot-${eventSeq}`,
        },
        "control",
      ),
    deps: {
      connect: async () => client,
      resolveComputer: async () => ({
        connectionId: "connection",
        environment: {
          id: "environment",
          connectionId: "connection",
          deviceId: "worker",
          connectionName: "worker",
          organizationId: "org",
          podId: null,
          connectedAt: null,
          lastHeartbeat: Date.now(),
          lastSeenAt: 1,
          firstSeenAt: 1,
          metadata: { subagent_message: true },
        },
      }),
    },
  };
}

function registerRunningTask(agentId: string) {
  registerSubagent(
    "existing",
    "codex",
    "Work",
    "call",
    true,
    false,
    parentScope,
  );
  updateSubagent("existing", { agentId, status: "running" });
  const task = {
    description: "Work",
    subagentType: "codex" as const,
    subagentId: "existing",
    status: "running" as "running" | "completed",
    startTime: new Date(),
    outputFile: "/tmp/existing",
  };
  backgroundTasks.set("existing", task);
  return task;
}

const workerEnv = {
  resolveSecretEnv: async () => ({}),
  resolveMcpReminder: async () => undefined,
};

afterEach(async () => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  clearAllSubagents();
  backgroundTasks.clear();
  __resetCodexSessionsForTests();
  __resetSubagentControlDedupeForTests();
  await clearNativeSessionCaptureForTests();
});

test.each(["environment setup", "thread/resume", "turn/start"])(
  "queues a follow-up during slow %s and still tracks the resumed turn",
  async (slowMethod) => {
    jest.useFakeTimers();
    const parent = createConversationRuntime(
      createRuntime(),
      runtime.agent_id,
      runtime.conversation_id,
    );
    const threadId = "22222222-2222-4222-8222-222222222222";
    const agentId = `codex_${threadId}`;
    rememberNativeSession(
      "codex",
      threadId,
      { ...parentScope, cloudSkillRepositories: ["api"] },
      "http://localhost:8283",
    );
    if (slowMethod === "turn/start") registerRunningTask(agentId);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const release = Promise.withResolvers<void>();
    const blocked = Promise.withResolvers<void>();
    const tracked = Promise.withResolvers<{
      completion: Promise<SubagentResult>;
    }>();
    const send = (value: unknown) => stdout.write(`${JSON.stringify(value)}\n`);
    let starts = 0;
    stdin.on("data", (chunk) => {
      const { id, method } = JSON.parse(chunk.toString());
      if (typeof id !== "number") return;
      let result = {};
      if (method === "thread/resume") result = { thread: { id: threadId } };
      if (method === "turn/start") {
        starts++;
        result = { turn: { id: "follow-up-turn" } };
      }
      if (method === slowMethod) {
        blocked.resolve();
        void release.promise.then(() => send({ id, result }));
      } else {
        send({ id, result });
      }
    });
    const received = Promise.withResolvers<SubagentMessageCommand>();
    const remote = remoteClient((command) => {
      received.resolve(command);
      return handleSubagentMessageCommand(command, parent, deps);
    });
    const deps: NonNullable<
      Parameters<typeof handleSubagentMessageCommand>[2]
    > = {
      workerEnv: {
        ...workerEnv,
        resolveMcpReminder: async () => {
          if (slowMethod === "environment setup") {
            blocked.resolve();
            await release.promise;
          }
          return undefined;
        },
      },
      sendCodex: (options) => {
        expect(options.cloudSkillRepositories).toEqual(["api"]);
        return sendCodexMessage(options, {
          createTransport: () => ({ stdin, stdout }),
        });
      },
      reserveCapture: async () => ({ capture: async () => {} }),
      track: jest.fn(({ completion, publishResult, toolCallId }) => {
        if (publishResult) {
          void completion.then((result: SubagentResult) =>
            remote.snapshot([
              {
                subagent_id: "resumed",
                subagent_type: "codex",
                description: "Continue",
                status: result.success ? "completed" : "error",
                tool_call_id: toolCallId,
                agent_url: null,
                start_time: 0,
                tool_calls: [],
                total_tokens: 0,
                duration_ms: 0,
                result: result.report,
              },
            ]),
          );
        }
        tracked.resolve({ completion });
        return {
          taskId: "follow-up",
          subagentId: "resumed",
          outputFile: "/tmp/follow-up",
        };
      }),
    };

    const callerTask = Promise.withResolvers<{
      completion: Promise<SubagentResult>;
    }>();
    const track = jest.fn(
      ({ completion }: { completion: Promise<SubagentResult> }) => {
        callerTask.resolve({ completion });
        return {
          taskId: "caller-task",
          subagentId: "caller-subagent",
          outputFile: "/tmp/caller",
        };
      },
    );
    const caller = sendRemoteExternalCodingAgentMessage(
      { agentId: `${agentId}@worker`, parentScope, message: "Continue" },
      { ...remote.deps, track },
    );
    const command = await received.promise;
    await blocked.promise;
    jest.advanceTimersByTime(10_000);
    try {
      const acknowledgment = await Promise.race([
        caller,
        new Promise<undefined>((resolve) => setImmediate(resolve)),
      ]);
      expect(acknowledgment).toEqual({
        delivery: "resumed",
        taskId: "caller-task",
        outputFile: "/tmp/caller",
      });
      expect(command.accepts_pending_resume).toBe(true);
      expect(deps.track).not.toHaveBeenCalled();
      remote.snapshot([]);
      expect(remote.close).not.toHaveBeenCalled();
      jest.advanceTimersByTime(31_000);
      expect(
        await handleSubagentMessageCommand(command, parent, deps),
      ).toMatchObject({
        success: true,
        delivery: "resuming",
      });
    } finally {
      release.resolve();
    }

    const { completion } = await tracked.promise;
    send({
      method: "turn/completed",
      params: {
        threadId,
        turn: {
          id: "follow-up-turn",
          status: "completed",
          items: [{ type: "agentMessage", text: "Follow-up finished" }],
        },
      },
    });
    expect(await completion).toMatchObject({
      success: true,
      report: "Follow-up finished",
    });
    expect(starts).toBe(1);
    expect(deps.track).toHaveBeenCalledTimes(1);
    expect(await (await callerTask.promise).completion).toMatchObject({
      success: true,
      report: "Follow-up finished",
    });
    expect(track).toHaveBeenCalledTimes(1);
    expect(remote.close).toHaveBeenCalledTimes(1);
  },
);

test.each([false, true])(
  "a slow steer uses the existing task (worker rejects: %s)",
  async (rejectSteer) => {
    jest.useFakeTimers();
    const parent = createConversationRuntime(
      createRuntime(),
      runtime.agent_id,
      runtime.conversation_id,
    );
    const threadId = "22222222-2222-4222-8222-222222222222";
    const agentId = `codex_${threadId}`;
    const task = registerRunningTask(agentId);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const send = (value: unknown) => stdout.write(`${JSON.stringify(value)}\n`);
    const settle = () =>
      send({
        method: "turn/completed",
        params: {
          threadId,
          turn: { id: "turn-1", status: "completed", items: [] },
        },
      });
    let starts = 0;
    let steers = 0;
    stdin.on("data", (chunk) => {
      const { id, method } = JSON.parse(chunk.toString());
      if (typeof id !== "number") return;
      if (method === "thread/start") {
        send({ id, result: { thread: { id: threadId } } });
      } else if (method === "turn/start") {
        send({ id, result: { turn: { id: `turn-${++starts}` } } });
      } else if (method === "turn/steer") {
        steers++;
        if (rejectSteer) {
          task.status = "completed";
          settle();
          send({ id, error: { message: "no active turn to steer" } });
        } else {
          send({ id, result: {} });
        }
      } else {
        send({ id, result: {} });
      }
    });
    const initial = await startCodexTurn(
      { parentAgentId: parentScope.agentId, cwd: "/tmp", prompt: "Initial" },
      { createTransport: () => ({ stdin, stdout }) },
    );

    const envStarted = Promise.withResolvers<void>();
    const releaseEnv = Promise.withResolvers<void>();
    const deliverySettled = Promise.withResolvers<void>();
    const reserveCapture = jest.fn(async () => ({ capture: async () => {} }));
    const report = jest
      .spyOn(telemetry, "trackError")
      .mockImplementation(() => {});
    const remote = remoteClient((command) =>
      handleSubagentMessageCommand(command, parent, {
        workerEnv: {
          ...workerEnv,
          resolveMcpReminder: async () => {
            envStarted.resolve();
            await releaseEnv.promise;
            return undefined;
          },
        },
        sendCodex: (options) =>
          sendCodexMessage(options).finally(deliverySettled.resolve),
        reserveCapture,
      }),
    );
    const track = jest.fn(() => {
      throw new Error("A steer uses the existing task");
    });
    const caller = sendRemoteExternalCodingAgentMessage(
      { agentId: `${agentId}@worker`, parentScope, message: "Continue" },
      { ...remote.deps, track },
    );
    await envStarted.promise;
    jest.advanceTimersByTime(10_000);
    try {
      expect(await caller).toEqual({ delivery: "queued" });
      expect(track).not.toHaveBeenCalled();
      expect(remote.close).toHaveBeenCalledTimes(1);
    } finally {
      releaseEnv.resolve();
    }
    await deliverySettled.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(steers).toBe(1);
    expect(starts).toBe(1);
    expect(reserveCapture).not.toHaveBeenCalled();
    if (rejectSteer) {
      expect(report).toHaveBeenCalledTimes(1);
      expect(report).toHaveBeenCalledWith(
        "remote_queued_followup_failed",
        "Queued remote follow-up delivery failed",
      );
    } else {
      expect(report).not.toHaveBeenCalled();
      settle();
    }
    await initial.completion;
  },
);

test("a caller without pending-resume support gets the ordinary resumed receipt", async () => {
  jest.useFakeTimers();
  const parent = createConversationRuntime(
    createRuntime(),
    runtime.agent_id,
    runtime.conversation_id,
  );
  const threadId = "22222222-2222-4222-8222-222222222222";
  const agentId = `codex_${threadId}`;
  rememberNativeSession(
    "codex",
    threadId,
    parentScope,
    "http://localhost:8283",
  );
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const response = handleSubagentMessageCommand(
    {
      type: "subagent_message",
      request_id: "legacy",
      agent_id: agentId,
      runtime,
      message: "Continue",
    },
    parent,
    {
      workerEnv,
      sendCodex: async () => {
        started.resolve();
        await release.promise;
        return {
          mode: "new_turn",
          threadId,
          turnId: "new",
          completion: Promise.resolve({
            agentId,
            success: true,
            report: "Done",
          }),
          interrupt: async () => {},
        };
      },
      track: () => ({
        taskId: "task",
        subagentId: "subagent",
        outputFile: "/tmp/out",
      }),
    },
  );

  await started.promise;
  jest.advanceTimersByTime(10_000);
  try {
    expect(
      await Promise.race([
        response,
        new Promise<undefined>((resolve) => setImmediate(resolve)),
      ]),
    ).toBeUndefined();
  } finally {
    release.resolve();
  }
  expect(await response).toMatchObject({ success: true, delivery: "resumed" });
});
