import { afterEach, describe, expect, test } from "bun:test";
import { TerminalFailureError } from "@/agent/terminal-failure";
import type { AgentRuntimeStatusSnapshot } from "@/backend/api/agents";
import type { EnvironmentConnection } from "@/backend/api/environments";
import { ApiRequestError } from "@/backend/api/request";
import {
  buildEnvironmentCreateMessageBody,
  resolveEnvironmentMaxWaitMs,
  waitForEnvironmentAssistantMessage,
} from "@/headless-environment-response";
import { toolFilter } from "@/tools/filter";

/** Pins the wait to the run-based fallback (server without the route). */
const runtimeStatusUnavailable =
  async (): Promise<AgentRuntimeStatusSnapshot> => {
    throw new ApiRequestError("Not Found", 404, "");
  };

function runtimeSnapshot(
  conversationId: string,
  state: "IDLE" | "PENDING_DELIVERY" | "ACTIVE" | "ACTIVE_UNATTRIBUTED",
  loopStatus: string | null = null,
): AgentRuntimeStatusSnapshot {
  return {
    agent_id: "agent-1",
    snapshot_at: 0,
    statuses: [
      {
        conversation_id: conversationId,
        state,
        loop_state: loopStatus === null ? null : { status: loopStatus },
        active_run_ids: [],
        last_activity_at: 0,
      },
    ],
  };
}

function assistantMessage(
  id: string,
  text: string,
  runId: string,
  sequenceId: number,
) {
  return {
    id,
    message_type: "assistant_message",
    date: "2026-07-07T12:00:00.000Z",
    content: [{ type: "text", text }],
    run_id: runId,
    seq_id: sequenceId,
  };
}

function userMessage(
  id: string,
  otid: string,
  runId: string,
  sequenceId: number,
  content = "Run the requested command",
) {
  return {
    id,
    message_type: "user_message",
    date: "2026-07-07T12:00:00.000Z",
    content,
    otid,
    run_id: runId,
    seq_id: sequenceId,
  };
}

describe("headless environment-routed responses", () => {
  test("follows the submitted input across continuation runs", async () => {
    let messageCalls = 0;
    const retrievedRunIds: string[] = [];

    const backend = {
      async retrieveRun(runId: string) {
        retrievedRunIds.push(runId);
        return {
          id: runId,
          status: "completed",
          stop_reason:
            runId === "run-requested" ? "requires_approval" : "end_turn",
        };
      },
      async listConversationMessages() {
        messageCalls += 1;
        if (messageCalls === 1) {
          return [
            assistantMessage(
              "msg-unrelated",
              "paused. the uncommitted fix only changes the test.",
              "run-unrelated",
              10,
            ),
          ];
        }
        if (messageCalls === 2) {
          return [
            assistantMessage(
              "msg-unrelated",
              "paused. the uncommitted fix only changes the test.",
              "run-unrelated",
              10,
            ),
            assistantMessage(
              "msg-initial",
              "Let me gather the concrete details.",
              "run-requested",
              12,
            ),
            userMessage("msg-user", "otid-requested", "run-requested", 11),
          ];
        }
        return [
          assistantMessage(
            "msg-next-turn",
            "This belongs to the next user message.",
            "run-next-turn",
            18,
          ),
          userMessage("msg-next-user", "otid-next", "run-next-turn", 17),
          assistantMessage(
            "msg-final",
            "Here's my concrete execution environment.",
            "run-continuation",
            15,
          ),
          assistantMessage(
            "msg-initial",
            "Let me gather the concrete details.",
            "run-requested",
            12,
          ),
          userMessage("msg-user", "otid-requested", "run-requested", 11),
          assistantMessage(
            "msg-unrelated",
            "paused. the uncommitted fix only changes the test.",
            "run-unrelated",
            10,
          ),
        ];
      },
      async listAgentMessages() {
        throw new Error("default conversation path should not be used");
      },
    };

    const result = await waitForEnvironmentAssistantMessage({
      backend: backend as never,
      agentId: "agent-env",
      conversationId: "conv-env",
      otid: "otid-requested",
      pollIntervalMs: 0,
      maxWaitMs: 1_000,
      deps: { getAgentRuntimeStatus: runtimeStatusUnavailable },
    });

    expect(result).toEqual({
      text: "Here's my concrete execution environment.",
      stopReason: "end_turn",
    });
    expect(messageCalls).toBe(3);
    expect(retrievedRunIds).toEqual(["run-requested", "run-continuation"]);
  });

  test("ignores task notifications while following the submitted turn", async () => {
    const retrievedRunIds: string[] = [];
    const backend = {
      async retrieveRun(runId: string) {
        retrievedRunIds.push(runId);
        return {
          id: runId,
          status: "completed",
          stop_reason:
            runId === "run-requested" ? "requires_approval" : "end_turn",
        };
      },
      async listConversationMessages() {
        return [
          assistantMessage(
            "msg-final",
            "The background task completed successfully.",
            "run-final",
            15,
          ),
          userMessage(
            "msg-task-notification",
            "otid-task-notification",
            "run-task-notification",
            13,
            "<task-notification>background command completed</task-notification>",
          ),
          assistantMessage(
            "msg-initial",
            "Waiting for the background task.",
            "run-requested",
            12,
          ),
          userMessage("msg-user", "otid-requested", "run-requested", 11),
        ];
      },
      async listAgentMessages() {
        throw new Error("default conversation path should not be used");
      },
    };

    const result = await waitForEnvironmentAssistantMessage({
      backend: backend as never,
      agentId: "agent-env",
      conversationId: "conv-env",
      otid: "otid-requested",
      pollIntervalMs: 0,
      maxWaitMs: 1_000,
      deps: { getAgentRuntimeStatus: runtimeStatusUnavailable },
    });

    expect(result).toEqual({
      text: "The background task completed successfully.",
      stopReason: "end_turn",
    });
    expect(retrievedRunIds).toEqual(["run-final"]);
  });
});

describe("buildEnvironmentCreateMessageBody", () => {
  afterEach(() => {
    toolFilter.reset();
  });

  test("includes client_tool_allowlist when a tool filter is set", () => {
    toolFilter.setEnabledTools("Read,Grep");

    const body = buildEnvironmentCreateMessageBody({
      agentId: "agent-1",
      conversationId: "conv-1",
      content: [{ type: "text", text: "hello" }],
      otid: "otid-1",
    });

    expect(body.client_tool_allowlist).toEqual(["Read", "Grep"]);
    expect(body.agentId).toBe("agent-1");
    expect(body.conversationId).toBe("conv-1");
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]?.otid).toBe("otid-1");
  });

  test("sends an empty allowlist when the filter allows no tools", () => {
    toolFilter.setEnabledTools("");

    const body = buildEnvironmentCreateMessageBody({
      agentId: "agent-1",
      conversationId: "conv-1",
      content: [{ type: "text", text: "hello" }],
      otid: "otid-1",
    });

    expect(body.client_tool_allowlist).toEqual([]);
  });

  test("omits client_tool_allowlist when no tool filter is set", () => {
    const body = buildEnvironmentCreateMessageBody({
      agentId: "agent-1",
      conversationId: "conv-1",
      content: [{ type: "text", text: "hello" }],
      otid: "otid-1",
    });

    expect("client_tool_allowlist" in body).toBe(false);
  });
});

function toolMessage(id: string, runId: string, sequenceId: number) {
  return {
    id,
    message_type: "tool_call_message",
    date: "2026-07-07T12:00:00.000Z",
    run_id: runId,
    seq_id: sequenceId,
  };
}

/** Fake clock: sleep() advances time instead of waiting. */
function makeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += Math.max(ms, 1);
    },
  };
}

function onlineConnection(deviceId: string): EnvironmentConnection {
  return {
    id: "env-row",
    connectionId: "conn-1",
    deviceId,
    connectionName: "test",
    organizationId: "org-1",
    podId: "pod-1",
    connectedAt: Date.now(),
    lastHeartbeat: Date.now(),
    lastSeenAt: Date.now(),
    firstSeenAt: Date.now(),
  };
}

function offlineConnection(deviceId: string): EnvironmentConnection {
  return {
    ...onlineConnection(deviceId),
    connectionId: null,
    lastHeartbeat: null,
  };
}

describe("environment turn liveness", () => {
  const baseMessages = [
    userMessage("msg-user", "otid-1", "run-1", 10),
    toolMessage("msg-tool", "run-1", 11),
  ];

  test("keeps waiting past ten minutes while the run is still executing", async () => {
    const clock = makeClock();
    let runStatus = "running";
    let listCalls = 0;
    const backend = {
      async retrieveRun(runId: string) {
        return {
          id: runId,
          status: runStatus,
          stop_reason: runStatus === "completed" ? "end_turn" : null,
        };
      },
      async listConversationMessages() {
        listCalls += 1;
        // Flip to completed after ~15 simulated minutes of polling.
        if (clock.now() >= 15 * 60_000 && runStatus === "running") {
          runStatus = "completed";
          return [
            ...baseMessages,
            assistantMessage(
              "msg-final",
              "done after a long tool call",
              "run-1",
              12,
            ),
          ];
        }
        return baseMessages;
      },
    };

    const result = await waitForEnvironmentAssistantMessage({
      backend: backend as never,
      agentId: "agent-1",
      conversationId: "conv-1",
      otid: "otid-1",
      pollIntervalMs: 1_000,
      deps: { ...clock, getAgentRuntimeStatus: runtimeStatusUnavailable },
    });

    expect(result.text).toBe("done after a long tool call");
    expect(clock.now()).toBeGreaterThan(10 * 60_000);
    expect(listCalls).toBeGreaterThan(600);
  });

  test("fails fast when the run fails without an assistant reply", async () => {
    const clock = makeClock();
    const backend = {
      async retrieveRun(runId: string) {
        return { id: runId, status: "failed", stop_reason: "error" };
      },
      async listConversationMessages() {
        return baseMessages;
      },
    };

    await expect(
      waitForEnvironmentAssistantMessage({
        backend: backend as never,
        agentId: "agent-1",
        conversationId: "conv-1",
        otid: "otid-1",
        pollIntervalMs: 1_000,
        deps: { ...clock, getAgentRuntimeStatus: runtimeStatusUnavailable },
      }),
    ).rejects.toThrow(/run run-1 failed without an assistant reply/);
    expect(clock.now()).toBeLessThan(60_000);
  });

  test("fails when the run completes without an assistant reply after the grace period", async () => {
    const clock = makeClock();
    const backend = {
      async retrieveRun(runId: string) {
        return { id: runId, status: "completed", stop_reason: "end_turn" };
      },
      async listConversationMessages() {
        return baseMessages;
      },
    };

    await expect(
      waitForEnvironmentAssistantMessage({
        backend: backend as never,
        agentId: "agent-1",
        conversationId: "conv-1",
        otid: "otid-1",
        pollIntervalMs: 1_000,
        runStatusIntervalMs: 1_000,
        deps: { ...clock, getAgentRuntimeStatus: runtimeStatusUnavailable },
      }),
    ).rejects.toThrow(/completed without an assistant reply/);
    expect(clock.now()).toBeLessThan(60_000);
  });

  test("fails when the device goes offline while waiting", async () => {
    const clock = makeClock();
    const backend = {
      async retrieveRun(runId: string) {
        return { id: runId, status: "running", stop_reason: null };
      },
      async listConversationMessages() {
        return baseMessages;
      },
    };

    await expect(
      waitForEnvironmentAssistantMessage({
        backend: backend as never,
        agentId: "agent-1",
        conversationId: "conv-1",
        otid: "otid-1",
        deviceId: "device-1",
        pollIntervalMs: 1_000,
        deps: {
          ...clock,
          getAgentRuntimeStatus: runtimeStatusUnavailable,
          getEnvironmentConnection: async () => offlineConnection("device-1"),
        },
      }),
    ).rejects.toThrow(/device device-1 went offline/);
    // First online check fires at the 30s interval, well before inactivity.
    expect(clock.now()).toBeLessThan(60_000);
  });

  test("ignores transient connection-lookup failures", async () => {
    const clock = makeClock();
    let lookups = 0;
    const backend = {
      async retrieveRun(runId: string) {
        if (clock.now() >= 90_000) {
          return { id: runId, status: "completed", stop_reason: "end_turn" };
        }
        return { id: runId, status: "running", stop_reason: null };
      },
      async listConversationMessages() {
        if (clock.now() >= 90_000) {
          return [
            ...baseMessages,
            assistantMessage("msg-final", "made it", "run-1", 12),
          ];
        }
        return baseMessages;
      },
    };

    const result = await waitForEnvironmentAssistantMessage({
      backend: backend as never,
      agentId: "agent-1",
      conversationId: "conv-1",
      otid: "otid-1",
      deviceId: "device-1",
      pollIntervalMs: 1_000,
      deps: {
        ...clock,
        getAgentRuntimeStatus: runtimeStatusUnavailable,
        getEnvironmentConnection: async () => {
          lookups += 1;
          throw new Error("HTTP 503");
        },
      },
    });

    expect(result.text).toBe("made it");
    expect(lookups).toBeGreaterThan(0);
  });

  test("fails after sustained inactivity even below the absolute ceiling", async () => {
    const clock = makeClock();
    const backend = {
      async retrieveRun() {
        throw new Error("should not be called: no run visible");
      },
      async listConversationMessages() {
        return []; // the listener never picked up the turn
      },
    };

    await expect(
      waitForEnvironmentAssistantMessage({
        backend: backend as never,
        agentId: "agent-1",
        conversationId: "conv-1",
        otid: "otid-1",
        pollIntervalMs: 1_000,
        inactivityTimeoutMs: 5 * 60_000,
        deps: { ...clock, getAgentRuntimeStatus: runtimeStatusUnavailable },
      }),
    ).rejects.toThrow(/No activity from the environment turn for 300000ms/);
    expect(clock.now()).toBeLessThan(6 * 60_000);
  });

  test("fails at the absolute ceiling even while the run stays alive", async () => {
    const clock = makeClock();
    const backend = {
      async retrieveRun(runId: string) {
        return { id: runId, status: "running", stop_reason: null };
      },
      async listConversationMessages() {
        return baseMessages;
      },
    };

    await expect(
      waitForEnvironmentAssistantMessage({
        backend: backend as never,
        agentId: "agent-1",
        conversationId: "conv-1",
        otid: "otid-1",
        pollIntervalMs: 1_000,
        maxWaitMs: 2 * 60_000,
        deps: { ...clock, getAgentRuntimeStatus: runtimeStatusUnavailable },
      }),
    ).rejects.toThrow(/did not complete within 120000ms/);
  });
});

describe("runtime-status wait mode", () => {
  const baseMessages = [
    userMessage("msg-user", "otid-1", "run-1", 10),
    toolMessage("msg-tool", "run-1", 11),
  ];

  test("surfaces a correlated terminal listener failure before an input message persists", async () => {
    const failure = {
      stage: "agent_turn",
      code: "not-enough-credits",
      message: "Your account does not have credits for this model.",
      http_status: 402,
      retryable: false,
      client_message_ids: ["client-message-1"],
    };
    const backend = {
      async retrieveRun() {
        throw new Error("should not retrieve a run");
      },
      async listConversationMessages() {
        return [];
      },
    };

    let caught: unknown;
    try {
      await waitForEnvironmentAssistantMessage({
        backend: backend as never,
        agentId: "agent-1",
        conversationId: "conv-1",
        otid: "otid-1",
        clientMessageId: "client-message-1",
        deps: {
          getAgentRuntimeStatus: async () => {
            const snapshot = runtimeSnapshot("conv-1", "IDLE");
            const [status] = snapshot.statuses;
            if (!status) throw new Error("missing test status");
            return {
              ...snapshot,
              statuses: [{ ...status, failure }],
            };
          },
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TerminalFailureError);
    expect((caught as TerminalFailureError).failure).toEqual(failure);
  });

  test("a non-IDLE record is progress: waits past inactivity with no new messages and no run polling", async () => {
    const clock = makeClock();
    let runRetrievals = 0;
    let statusCalls = 0;
    const backend = {
      async retrieveRun(runId: string) {
        runRetrievals += 1;
        return { id: runId, status: "completed", stop_reason: "end_turn" };
      },
      async listConversationMessages() {
        if (clock.now() >= 15 * 60_000) {
          return [
            ...baseMessages,
            assistantMessage(
              "msg-final",
              "done after a long tool call",
              "run-1",
              12,
            ),
          ];
        }
        return baseMessages;
      },
    };

    const result = await waitForEnvironmentAssistantMessage({
      backend: backend as never,
      agentId: "agent-1",
      conversationId: "conv-1",
      otid: "otid-1",
      pollIntervalMs: 1_000,
      deps: {
        ...clock,
        getAgentRuntimeStatus: async () => {
          statusCalls += 1;
          if (clock.now() >= 15 * 60_000) {
            return runtimeSnapshot("conv-1", "IDLE");
          }
          return runtimeSnapshot(
            "conv-1",
            "ACTIVE",
            "EXECUTING_CLIENT_SIDE_TOOL",
          );
        },
      },
    });

    expect(result.text).toBe("done after a long tool call");
    expect(result.stopReason).toBe("end_turn");
    expect(clock.now()).toBeGreaterThan(10 * 60_000);
    expect(statusCalls).toBeGreaterThan(50);
    // Per-run polling stops in runtime-status mode; one final best-effort
    // lookup fills the stop reason.
    expect(runRetrievals).toBe(1);
  });

  test("returns when the owner reports WAITING_ON_INPUT even while unrelated work holds the record ACTIVE", async () => {
    const clock = makeClock();
    const backend = {
      async retrieveRun(runId: string) {
        return { id: runId, status: "completed", stop_reason: "end_turn" };
      },
      async listConversationMessages() {
        return [
          ...baseMessages,
          assistantMessage("msg-final", "reply landed", "run-1", 12),
        ];
      },
    };

    const result = await waitForEnvironmentAssistantMessage({
      backend: backend as never,
      agentId: "agent-1",
      conversationId: "conv-1",
      otid: "otid-1",
      pollIntervalMs: 1_000,
      deps: {
        ...clock,
        // An armed Monitor keeps the outer state ACTIVE after the turn.
        getAgentRuntimeStatus: async () =>
          runtimeSnapshot("conv-1", "ACTIVE", "WAITING_ON_INPUT"),
      },
    });

    expect(result.text).toBe("reply landed");
    expect(clock.now()).toBeLessThan(10_000);
  });

  test("fails after the grace period when the record goes IDLE without a reply", async () => {
    const clock = makeClock();
    const backend = {
      async retrieveRun() {
        throw new Error("should not be called in runtime-status mode");
      },
      async listConversationMessages() {
        return baseMessages;
      },
    };

    await expect(
      waitForEnvironmentAssistantMessage({
        backend: backend as never,
        agentId: "agent-1",
        conversationId: "conv-1",
        otid: "otid-1",
        pollIntervalMs: 1_000,
        runStatusIntervalMs: 1_000,
        deps: {
          ...clock,
          getAgentRuntimeStatus: async () => runtimeSnapshot("conv-1", "IDLE"),
        },
      }),
    ).rejects.toThrow(
      /ended without an assistant reply \(runtime state IDLE\)/,
    );
    expect(clock.now()).toBeLessThan(60_000);
  });

  test("transient runtime-status failures leave the run-based signals in charge", async () => {
    const clock = makeClock();
    let statusCalls = 0;
    const backend = {
      async retrieveRun(runId: string) {
        return { id: runId, status: "completed", stop_reason: "end_turn" };
      },
      async listConversationMessages() {
        return [
          ...baseMessages,
          assistantMessage("msg-final", "made it anyway", "run-1", 12),
        ];
      },
    };

    const result = await waitForEnvironmentAssistantMessage({
      backend: backend as never,
      agentId: "agent-1",
      conversationId: "conv-1",
      otid: "otid-1",
      pollIntervalMs: 1_000,
      deps: {
        ...clock,
        getAgentRuntimeStatus: async () => {
          statusCalls += 1;
          throw new ApiRequestError("Internal Server Error", 500, "");
        },
      },
    });

    expect(result.text).toBe("made it anyway");
    expect(statusCalls).toBeGreaterThan(0);
  });
});

describe("resolveEnvironmentMaxWaitMs", () => {
  test("defaults to one hour and honors LETTA_ENVIRONMENT_TIMEOUT_MS", () => {
    const previous = process.env.LETTA_ENVIRONMENT_TIMEOUT_MS;
    try {
      delete process.env.LETTA_ENVIRONMENT_TIMEOUT_MS;
      expect(resolveEnvironmentMaxWaitMs()).toBe(60 * 60_000);
      process.env.LETTA_ENVIRONMENT_TIMEOUT_MS = "7200000";
      expect(resolveEnvironmentMaxWaitMs()).toBe(7_200_000);
      process.env.LETTA_ENVIRONMENT_TIMEOUT_MS = "not-a-number";
      expect(resolveEnvironmentMaxWaitMs()).toBe(60 * 60_000);
    } finally {
      if (previous === undefined) {
        delete process.env.LETTA_ENVIRONMENT_TIMEOUT_MS;
      } else {
        process.env.LETTA_ENVIRONMENT_TIMEOUT_MS = previous;
      }
    }
  });
});
