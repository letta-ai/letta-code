import { afterEach, describe, expect, jest, spyOn, test } from "bun:test";
import {
  clearAllSubagents,
  completeSubagent,
  getSubagents,
  registerSubagent,
  updateSubagent,
} from "@/agent/subagent-state";
import type { SubagentResult } from "@/agent/subagents";
import type { AppServerClient } from "@/app-server-client";
import { telemetry } from "@/telemetry";
import { REMOTE_SUBAGENT_MESSAGE_DEDUPE_PENDING_TTL_MS } from "@/tools/impl/claude-steer-timeouts";
import type { sendClaudeMessage } from "@/tools/impl/claude-stream-session";
import {
  clearNativeSessionCaptureForTests,
  rememberNativeSession,
} from "@/tools/impl/native-session-capture";
import {
  backgroundTasks,
  scheduleBackgroundTaskCleanup,
} from "@/tools/impl/process_manager";
import { sendRemoteExternalCodingAgentMessage } from "@/tools/impl/remote-external-coding-agent";
import type { SubagentMessageCommand } from "@/types/subagent-protocol";
import { readSubagentDepth } from "@/utils/subagent-depth-env";
import { createRuntime } from "@/websocket/listener/lifecycle";
import { createConversationRuntime } from "@/websocket/listener/runtime";
import {
  __resetSubagentControlDedupeForTests,
  handleSubagentMessageCommand,
  handleSubagentStopCommand,
} from "./subagent-control";

const nativeId = "claude_11111111-1111-4111-8111-111111111111";
const runtime = { agent_id: "agent-a", conversation_id: "conv-a" };

function fixture() {
  const parent = createConversationRuntime(
    createRuntime(),
    runtime.agent_id,
    runtime.conversation_id,
  );
  registerSubagent("subagent-1", "claude-code", "Work", "call-1", true, false, {
    agentId: runtime.agent_id,
    conversationId: runtime.conversation_id,
  });
  updateSubagent("subagent-1", { agentId: nativeId, status: "running" });
  const abortController = new AbortController();
  backgroundTasks.set("task-1", {
    description: "Work",
    subagentType: "claude-code",
    subagentId: "subagent-1",
    status: "running",
    startTime: new Date(),
    outputFile: "/tmp/out",
    abortController,
  });
  return { parent, abortController };
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
  __resetSubagentControlDedupeForTests();
  await clearNativeSessionCaptureForTests();
});

function evictedFixture() {
  jest.useFakeTimers();
  const { parent } = fixture();
  rememberNativeSession(
    "claude_code",
    nativeId.slice("claude_".length),
    { agentId: runtime.agent_id, conversationId: runtime.conversation_id },
    "http://localhost:8283",
  );
  const task = backgroundTasks.get("task-1");
  if (task) task.status = "completed";
  scheduleBackgroundTaskCleanup("task-1");
  completeSubagent("subagent-1", { success: true, result: "Done" });
  jest.advanceTimersByTime(5 * 60_000 + 1);
  expect(backgroundTasks.has("task-1")).toBe(false);
  expect(getSubagents()[0]?.status).toBe("completed");
  return { parent };
}

describe("remote external subagent control", () => {
  test("rejects a subagent owned by another runtime", async () => {
    const { parent } = fixture();
    const response = await handleSubagentMessageCommand(
      {
        type: "subagent_message",
        request_id: "wrong-scope",
        runtime: { agent_id: "agent-b", conversation_id: "conv-b" },
        agent_id: nativeId,
        message: "Continue",
      },
      parent,
    );
    expect(response).toMatchObject({ success: false });
  });

  test("reports a session missing from this computer for message and stop", async () => {
    const { parent } = fixture();
    const agentId = "claude_22222222-2222-4222-8222-222222222222";
    const expected = {
      success: false,
      error: `Subagent ${agentId} was not found on this computer`,
    };
    expect(
      await handleSubagentMessageCommand(
        {
          type: "subagent_message",
          request_id: "missing-message",
          runtime,
          agent_id: agentId,
          message: "Continue",
        },
        parent,
      ),
    ).toMatchObject(expected);
    expect(
      await handleSubagentStopCommand(
        {
          type: "subagent_stop",
          request_id: "missing-stop",
          runtime,
          agent_id: agentId,
        },
        parent,
      ),
    ).toMatchObject(expected);
  });

  for (const evicted of [false, true]) {
    test(`accepts a same-agent handoff and rejects another agent (${evicted ? "persisted session" : "live task"})`, async () => {
      if (evicted) evictedFixture();
      else {
        fixture();
        const task = backgroundTasks.get("task-1");
        if (task) task.completion = Promise.resolve();
      }
      for (const agentId of [runtime.agent_id, "agent-other"]) {
        const scope = { agent_id: agentId, conversation_id: "conv-handoff" };
        const parent = createConversationRuntime(
          createRuntime(),
          scope.agent_id,
          scope.conversation_id,
        );
        let trackedScope: unknown;
        let sends = 0;
        const response = await handleSubagentMessageCommand(
          {
            type: "subagent_message",
            request_id: `handoff-${agentId}`,
            runtime: scope,
            agent_id: nativeId,
            message: "Continue here",
          },
          parent,
          {
            workerEnv,
            sendClaude: async () => {
              sends += 1;
              return {
                mode: "resumed",
                sessionId: nativeId,
                completion: Promise.resolve({
                  agentId: nativeId,
                  success: true,
                  report: "Done",
                }),
                interrupt: async () => {},
              };
            },
            track: (args) => {
              trackedScope = args.parentScope;
              return {
                taskId: "followup",
                outputFile: "/tmp/followup",
                subagentId: "followup",
              };
            },
          },
        );
        const owned = agentId === runtime.agent_id;
        expect(response.success).toBe(owned);
        expect(sends).toBe(owned ? 1 : 0);
        if (owned) {
          expect(response).toMatchObject({ delivery: "resumed" });
          expect(trackedScope).toMatchObject({
            agentId,
            conversationId: scope.conversation_id,
          });
        }
        const stopped = await handleSubagentStopCommand(
          {
            type: "subagent_stop",
            request_id: `handoff-stop-${agentId}`,
            runtime: scope,
            agent_id: nativeId,
          },
          parent,
        );
        expect(stopped.success).toBe(owned);
      }
    });
  }

  test("reports steered without passing a disconnect signal", async () => {
    const { parent } = fixture();
    let signal: AbortSignal | undefined;
    const response = await handleSubagentMessageCommand(
      {
        type: "subagent_message",
        request_id: "steer",
        runtime,
        agent_id: nativeId,
        message: "Change course",
      },
      parent,
      {
        workerEnv,
        sendClaude: async (options) => {
          signal = options.signal;
          return { mode: "steered", sessionId: nativeId };
        },
      },
    );
    expect(signal).toBeUndefined();
    expect(response).toMatchObject({ success: true, delivery: "steered" });
  });

  test("reports a steer queued behind an unacknowledged interrupt", async () => {
    const { parent } = fixture();
    const response = await handleSubagentMessageCommand(
      {
        type: "subagent_message",
        request_id: "queued-steer",
        runtime,
        agent_id: nativeId,
        message: "Change course",
      },
      parent,
      {
        workerEnv,
        sendClaude: async () => ({
          mode: "steered",
          sessionId: nativeId,
          queued: true,
        }),
      },
    );
    expect(response).toMatchObject({ success: true, delivery: "queued" });
  });

  test("deduplicates a retried request ID", async () => {
    const { parent } = fixture();
    let calls = 0;
    const command = {
      type: "subagent_message" as const,
      request_id: "duplicate",
      runtime,
      agent_id: nativeId,
      message: "Only once",
    };
    const deps = {
      workerEnv,
      sendClaude: async () => {
        calls += 1;
        return { mode: "steered" as const, sessionId: nativeId };
      },
    };
    const [first, second] = await Promise.all([
      handleSubagentMessageCommand(command, parent, deps),
      handleSubagentMessageCommand(command, parent, deps),
    ]);
    expect(calls).toBe(1);
    expect(second).toEqual(first);
  });

  test("reconnects a closed follow-up socket without steering twice, even during a slow steer", async () => {
    const { parent } = fixture();
    const started = Promise.withResolvers<void>();
    const receipt = Promise.withResolvers<{
      mode: "steered";
      sessionId: string;
    }>();
    let now = 0;
    let steers = 0;
    const deps = {
      workerEnv,
      now: () => now,
      sendClaude: async () => {
        steers++;
        started.resolve();
        return receipt.promise;
      },
    };
    const commands: SubagentMessageCommand[] = [];
    const pending: Promise<unknown>[] = [];
    const closes = [jest.fn(), jest.fn()];
    const clients = closes.map(
      (close, attempt) =>
        ({
          close,
          onMessage: () => () => {},
          onDisconnect: () => () => {},
          sendSubagentMessage: async (command: SubagentMessageCommand) => {
            commands.push(command);
            const response = handleSubagentMessageCommand(
              command,
              parent,
              deps,
            );
            pending.push(response);
            if (attempt === 0) {
              await started.promise;
              now = 31_000;
              throw new Error("App-server socket closed");
            }
            receipt.resolve({ mode: "steered", sessionId: nativeId });
            return response;
          },
        }) as unknown as AppServerClient,
    );
    let attempts = 0;
    const resolvedIds: string[] = [];
    const result = await sendRemoteExternalCodingAgentMessage(
      {
        agentId: `${nativeId}@computer`,
        parentScope: {
          agentId: runtime.agent_id,
          conversationId: runtime.conversation_id,
        },
        message: "Only once",
        toolCallId: "follow-up-1",
      },
      {
        resolveComputer: async () => ({
          connectionId: `conn-${resolvedIds.length + 1}`,
          environment: remoteEnvironment(),
        }),
        connect: async (id) => {
          resolvedIds.push(id);
          return clients[attempts++] as AppServerClient;
        },
      },
    );
    await Promise.all(pending);
    expect(result).toEqual({ delivery: "steered" });
    expect(resolvedIds).toEqual(["conn-1", "conn-2"]);
    expect(commands).toHaveLength(2);
    expect(commands[1]).toEqual(commands[0]);
    expect(steers).toBe(1);
    for (const close of closes) expect(close).toHaveBeenCalledTimes(1);
    now = 60_000;
    await handleSubagentMessageCommand(
      commands[0] as SubagentMessageCommand,
      parent,
      deps,
    );
    expect(steers).toBe(1);
  });

  test("reports socket_closed after both follow-up attempts lose their socket", async () => {
    const report = spyOn(telemetry, "trackError").mockImplementation(() => {});
    spyOn(telemetry, "flush").mockResolvedValue(undefined);
    const commands: SubagentMessageCommand[] = [];
    const closes = [jest.fn(), jest.fn()];
    let attempts = 0;
    const resolveComputer = jest.fn(async () => ({
      connectionId: "conn-test",
      environment: remoteEnvironment(),
    }));
    await expect(
      sendRemoteExternalCodingAgentMessage(
        {
          agentId: `${nativeId}@computer`,
          parentScope: {
            agentId: runtime.agent_id,
            conversationId: runtime.conversation_id,
          },
          message: "Continue",
        },
        {
          resolveComputer,
          connect: async () =>
            ({
              close: closes[attempts++],
              onMessage: () => () => {},
              onDisconnect: () => () => {},
              sendSubagentMessage: async (command: SubagentMessageCommand) => {
                commands.push(command);
                throw new Error("App-server socket closed");
              },
            }) as unknown as AppServerClient,
        },
      ),
    ).rejects.toThrow("The message may not have been delivered");
    expect(commands).toHaveLength(2);
    expect(commands[1]).toEqual(commands[0]);
    expect(resolveComputer).toHaveBeenCalledTimes(2);
    expect(attempts).toBe(2);
    for (const close of closes) expect(close).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledTimes(1);
    expect(JSON.parse(report.mock.calls[0]?.[2] as string).error_code).toBe(
      "socket_closed",
    );
  });

  test("evicts a stuck pending steer after the caller retry budget cap", async () => {
    const { parent } = fixture();
    const started = [
      Promise.withResolvers<void>(),
      Promise.withResolvers<void>(),
    ] as const;
    const receipts = [
      Promise.withResolvers<{ mode: "steered"; sessionId: string }>(),
      Promise.withResolvers<{ mode: "steered"; sessionId: string }>(),
    ] as const;
    let now = 0;
    let steers = 0;
    const command: SubagentMessageCommand = {
      type: "subagent_message",
      request_id: "stuck-steer",
      runtime,
      agent_id: nativeId,
      message: "Only retry after the cap",
    };
    const deps = {
      workerEnv,
      now: () => now,
      sendClaude: async () => {
        const attempt = steers++;
        started[attempt]?.resolve();
        const receipt = receipts[attempt];
        if (!receipt) throw new Error("Unexpected extra steer");
        return receipt.promise;
      },
    };
    const original = handleSubagentMessageCommand(command, parent, deps);
    await started[0].promise;
    now = REMOTE_SUBAGENT_MESSAGE_DEDUPE_PENDING_TTL_MS - 1;
    const beforeCap = handleSubagentMessageCommand(command, parent, deps);
    expect(steers).toBe(1);

    now = REMOTE_SUBAGENT_MESSAGE_DEDUPE_PENDING_TTL_MS + 1;
    const afterCap = handleSubagentMessageCommand(command, parent, deps);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(steers).toBe(2);

    receipts[0].resolve({ mode: "steered", sessionId: nativeId });
    await Promise.all([original, beforeCap]);
    now += 31_000;
    const retry = handleSubagentMessageCommand(command, parent, deps);
    receipts[1].resolve({ mode: "steered", sessionId: nativeId });
    await Promise.all([afterCap, retry]);
    expect(steers).toBe(2);
  });

  test("delivers the same request ID from different parents", async () => {
    const { parent: firstParent } = fixture();
    const secondRuntime = { agent_id: "agent-b", conversation_id: "conv-b" };
    const secondParent = createConversationRuntime(
      createRuntime(),
      secondRuntime.agent_id,
      secondRuntime.conversation_id,
    );
    registerSubagent(
      "subagent-2",
      "claude-code",
      "Other work",
      "call-2",
      true,
      false,
      {
        agentId: secondRuntime.agent_id,
        conversationId: secondRuntime.conversation_id,
      },
    );
    updateSubagent("subagent-2", { agentId: nativeId, status: "running" });
    backgroundTasks.set("task-2", {
      description: "Other work",
      subagentType: "claude-code",
      subagentId: "subagent-2",
      status: "running",
      startTime: new Date(),
      outputFile: "/tmp/out-2",
      abortController: new AbortController(),
    });
    let calls = 0;
    const sendClaude = async () => {
      calls += 1;
      return { mode: "steered" as const, sessionId: nativeId };
    };
    const command = {
      type: "subagent_message" as const,
      request_id: "same-request",
      agent_id: nativeId,
      message: "Continue",
    };

    const [first, second] = await Promise.all([
      handleSubagentMessageCommand({ ...command, runtime }, firstParent, {
        workerEnv,
        sendClaude,
      }),
      handleSubagentMessageCommand(
        { ...command, runtime: secondRuntime },
        secondParent,
        { workerEnv, sendClaude },
      ),
    ]);

    expect(calls).toBe(2);
    expect(first).toMatchObject({ success: true });
    expect(second).toMatchObject({ success: true });
  });

  test("tracks resumed work with the caller tool call ID", async () => {
    const { parent } = fixture();
    let tracked: Record<string, unknown> | undefined;
    const completion = Promise.resolve({
      agentId: nativeId,
      success: true,
      report: "Done",
    } satisfies SubagentResult);
    const response = await handleSubagentMessageCommand(
      {
        type: "subagent_message",
        request_id: "resume",
        runtime,
        agent_id: nativeId,
        message: "Continue",
        tool_call_id: "follow-call",
      },
      parent,
      {
        workerEnv,
        sendClaude: async () => ({
          mode: "resumed",
          sessionId: nativeId,
          completion,
          interrupt: async () => {},
        }),
        track: ((args: Record<string, unknown>) => {
          tracked = args;
          return {
            taskId: "task-follow",
            outputFile: "/tmp/follow",
            subagentId: "subagent-follow",
          };
        }) as never,
      },
    );
    expect(response).toMatchObject({ success: true, delivery: "resumed" });
    expect(tracked).toMatchObject({
      toolCallId: "follow-call",
      publishResult: true,
    });
  });

  test("routes the resumed completion to the caller instead of running it here", async () => {
    const { parent } = fixture();
    let tracked: Record<string, unknown> | undefined;
    const completion = Promise.resolve({
      agentId: nativeId,
      success: true,
      report: "Done",
    } satisfies SubagentResult);
    await handleSubagentMessageCommand(
      {
        type: "subagent_message",
        request_id: "resume-scope",
        runtime,
        agent_id: nativeId,
        message: "Continue",
      },
      parent,
      {
        workerEnv,
        sendClaude: async () => ({
          mode: "resumed",
          sessionId: nativeId,
          completion,
          interrupt: async () => {},
        }),
        track: ((args: Record<string, unknown>) => {
          tracked = args;
          return {
            taskId: "task-follow",
            outputFile: "/tmp/follow",
            subagentId: "subagent-follow",
          };
        }) as never,
      },
    );
    expect(tracked).toMatchObject({
      publishResult: true,
      emitCompletionNotification: false,
      claimsParentRuntime: false,
    });
  });

  test("interrupts untracked resumed work and allows the request to retry", async () => {
    const { parent } = fixture();
    let interrupts = 0;
    let sends = 0;
    let captures = 0;
    const command = {
      type: "subagent_message" as const,
      request_id: "tracking-failure",
      runtime,
      agent_id: nativeId,
      message: "Continue",
    };
    const deps: NonNullable<
      Parameters<typeof handleSubagentMessageCommand>[2]
    > = {
      workerEnv,
      sendClaude: async (options) => {
        sends += 1;
        await options.beforeStart?.();
        return {
          mode: "resumed" as const,
          sessionId: nativeId,
          completion: Promise.resolve({
            agentId: nativeId,
            success: false,
            report: "Interrupted",
          } satisfies SubagentResult),
          interrupt: async () => {
            interrupts += 1;
          },
        };
      },
      reserveCapture: async () => ({
        capture: async () => {
          captures += 1;
        },
      }),
      track: (() => {
        throw new Error("tracking failed");
      }) as never,
    };

    const first = await handleSubagentMessageCommand(command, parent, deps);
    await Promise.resolve();
    const second = await handleSubagentMessageCommand(command, parent, deps);

    expect(first).toMatchObject({ success: false, error: "tracking failed" });
    expect(second).toMatchObject({ success: false, error: "tracking failed" });
    expect(interrupts).toBe(2);
    expect(sends).toBe(2);
    expect(captures).toBe(2);
  });

  test("resumes Claude Code with the same environment as a launch", async () => {
    const { parent } = fixture();
    let sent: Parameters<typeof sendClaudeMessage> | undefined;
    let tracked: Promise<SubagentResult> | undefined;
    const response = await handleSubagentMessageCommand(
      {
        type: "subagent_message",
        request_id: "resume-env",
        runtime: { ...runtime, acting_user_id: "user-a" },
        agent_id: nativeId,
        message: "Continue",
      },
      parent,
      {
        workerEnv: {
          env: { PATH: process.env.PATH },
          resolveSecretEnv: async () => ({ GITHUB_TOKEN: "vault-token-123" }),
          resolveMcpReminder: async () => "MCP servers available: github",
        },
        sendClaude: async (...args) => {
          sent = args;
          return {
            mode: "resumed",
            sessionId: nativeId,
            completion: Promise.resolve({
              agentId: nativeId,
              success: true,
              report: "pushed with vault-token-123",
            }),
            interrupt: async () => {},
          };
        },
        track: ((args: { completion: Promise<SubagentResult> }) => {
          tracked = args.completion;
          return {
            taskId: "task-follow",
            outputFile: "/tmp/follow",
            subagentId: "subagent-follow",
          };
        }) as never,
      },
    );
    expect(response).toMatchObject({ success: true, delivery: "resumed" });
    expect(sent?.[1]?.env).toMatchObject({
      GITHUB_TOKEN: "vault-token-123",
      LETTA_PARENT_AGENT_ID: "agent-a",
      LETTA_CODE_AGENT_ROLE: "subagent",
      LETTA_SUBAGENT_DEPTH: String(readSubagentDepth(process.env) + 1),
      LETTA_ACTING_USER_ID: "user-a",
    });
    expect(sent?.[0].mcpReminder).toContain("MCP servers available: github");
    expect((await tracked)?.report).not.toContain("vault-token-123");
  });

  test("stops the owning background task", async () => {
    const { parent, abortController } = fixture();
    const task = backgroundTasks.get("task-1");
    if (task) task.completion = Promise.resolve();
    const response = await handleSubagentStopCommand(
      {
        type: "subagent_stop",
        request_id: "stop",
        runtime,
        agent_id: nativeId,
      },
      parent,
    );
    expect(response).toMatchObject({ success: true, stopped: true });
    expect(abortController.signal.aborted).toBe(true);
  });

  describe("after the finished task is evicted", () => {
    test("steers for the launching conversation", async () => {
      const { parent } = evictedFixture();
      const response = await handleSubagentMessageCommand(
        {
          type: "subagent_message",
          request_id: "steer-evicted",
          runtime,
          agent_id: nativeId,
          message: "One more thing",
        },
        parent,
        {
          workerEnv,
          sendClaude: async () => ({ mode: "steered", sessionId: nativeId }),
        },
      );
      expect(response).toMatchObject({ success: true, delivery: "steered" });
    });

    test("resumes for the launching conversation", async () => {
      const { parent } = evictedFixture();
      let tracked = false;
      const response = await handleSubagentMessageCommand(
        {
          type: "subagent_message",
          request_id: "resume-evicted",
          runtime,
          agent_id: nativeId,
          message: "Continue",
        },
        parent,
        {
          workerEnv,
          sendClaude: async () => ({
            mode: "resumed",
            sessionId: nativeId,
            completion: Promise.resolve({
              agentId: nativeId,
              success: true,
              report: "Done",
            } satisfies SubagentResult),
            interrupt: async () => {},
          }),
          track: (() => {
            tracked = true;
            return {
              taskId: "task-follow",
              outputFile: "/tmp/follow",
              subagentId: "subagent-follow",
            };
          }) as never,
        },
      );
      expect(response).toMatchObject({ success: true, delivery: "resumed" });
      expect(tracked).toBe(true);
    });

    test("rejects another agent", async () => {
      evictedFixture();
      const other = { agent_id: "agent-other", conversation_id: "conv-other" };
      const otherParent = createConversationRuntime(
        createRuntime(),
        other.agent_id,
        other.conversation_id,
      );
      let sends = 0;
      const response = await handleSubagentMessageCommand(
        {
          type: "subagent_message",
          request_id: "steer-other",
          runtime: other,
          agent_id: nativeId,
          message: "Not yours",
        },
        otherParent,
        {
          workerEnv,
          sendClaude: async () => {
            sends += 1;
            return { mode: "steered", sessionId: nativeId };
          },
        },
      );
      expect(response).toMatchObject({
        success: false,
        error: "Subagent does not belong to this conversation",
      });
      expect(sends).toBe(0);
      expect(
        await handleSubagentStopCommand(
          {
            type: "subagent_stop",
            request_id: "stop-other",
            runtime: other,
            agent_id: nativeId,
          },
          otherParent,
        ),
      ).toMatchObject({ success: false });
    });

    test("reports nothing left to stop for the launching conversation", async () => {
      const { parent } = evictedFixture();
      expect(
        await handleSubagentStopCommand(
          {
            type: "subagent_stop",
            request_id: "stop-evicted",
            runtime,
            agent_id: nativeId,
          },
          parent,
        ),
      ).toMatchObject({ success: true, stopped: false });
    });
  });
});

function remoteEnvironment() {
  return {
    id: "env-test",
    connectionId: "conn-test",
    deviceId: "computer",
    connectionName: "computer",
    organizationId: "org-test",
    podId: null,
    connectedAt: null,
    lastHeartbeat: Date.now(),
    lastSeenAt: 1,
    firstSeenAt: 1,
    metadata: { subagent_message: true },
  };
}
