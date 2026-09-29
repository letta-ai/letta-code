import { expect, test } from "bun:test";
import type { Run } from "@letta-ai/letta-client/resources/agents/messages";
import type {
  EnqueueReceipt,
  ExactSuperRun,
} from "@/backend/api/conversation-enqueue";
import { ApiRequestError } from "@/backend/api/request";
import { cancelAcceptedRemoteTurn } from "./remote-turn-cancel";

const receipt: EnqueueReceipt = {
  status: "queued",
  agent_id: "agent-child",
  conversation_id: "conv-child",
  client_message_id: "message-accepted",
  workflow_id: "workflow-1",
  super_run_id: "super-run-accepted",
};

function exact(overrides: Partial<ExactSuperRun> = {}): ExactSuperRun {
  return {
    id: receipt.super_run_id,
    status: "PEN",
    completed_at: null,
    cancelled_at: null,
    errored_at: null,
    error: null,
    run_ids: [],
    ...overrides,
  };
}

function terminalRun(id: string): Run {
  return { id, status: "cancelled" } as Run;
}

function runtimeEntry() {
  return {
    conversation_id: receipt.conversation_id,
    state: "IDLE" as const,
    loop_state: null,
    active_run_ids: [],
    last_activity_at: 1,
  };
}

function inactiveRuntime() {
  return {
    agent_id: receipt.agent_id,
    snapshot_at: 1,
    statuses: [runtimeEntry()],
  };
}

test("a dequeued queued send is confirmed only after its exact Super Run settles", async () => {
  let reads = 0;
  const cancelled: string[] = [];
  const result = await cancelAcceptedRemoteTurn(receipt, {
    dequeue: async () => ({
      client_message_id: receipt.client_message_id,
      status: "dequeued",
    }),
    exact: async () =>
      ++reads === 1 ? exact() : exact({ status: "CAN", cancelled_at: "now" }),
    cancelRun: async (_agentId, runId) => {
      cancelled.push(runId);
    },
    retrieveRun: async (runId) => terminalRun(runId),
    runtimeStatus: async () => inactiveRuntime(),
    sleep: async () => {},
    timeoutMs: 100,
  });

  expect(result).toEqual({ status: "confirmed" });
  expect(reads).toBe(2);
  expect(cancelled).toEqual([]);
});

test.each([
  { name: "listener-owned", connection_id: "listener-1" },
  { name: "ownerless", connection_id: undefined },
])(
  "$name non-default execution is only confirmed after it becomes terminal",
  async (variant) => {
    const scopedReceipt = { ...receipt, connection_id: variant.connection_id };
    const cancellationRequests: Array<{
      conversationId: string;
      runId: string;
    }> = [];
    let reads = 0;
    const result = await cancelAcceptedRemoteTurn(scopedReceipt, {
      dequeue: async () => ({
        client_message_id: receipt.client_message_id,
        status: "too_late",
      }),
      exact: async () =>
        ++reads === 1
          ? exact({ run_ids: ["run-own"] })
          : exact({
              status: "CAN",
              cancelled_at: "now",
              run_ids: ["run-own"],
            }),
      cancelRun: async (agentId, runId) => {
        throw new Error(`unexpected agent cancellation: ${agentId}/${runId}`);
      },
      cancelConversationRun: async (conversationId, runId) => {
        cancellationRequests.push({ conversationId, runId });
        return { [runId]: "cancelled" };
      },
      retrieveRun: async (runId) => terminalRun(runId),
      runtimeStatus: async () => inactiveRuntime(),
      sleep: async () => {},
      timeoutMs: 100,
    });

    expect(result).toEqual({ status: "confirmed" });
    expect(cancellationRequests).toEqual([
      { conversationId: receipt.conversation_id, runId: "run-own" },
    ]);
  },
);

test("a fresh child's default conversation uses agent-scoped exact cancellation", async () => {
  const defaultReceipt = { ...receipt, conversation_id: "default" };
  const cancelled: Array<{ agentId: string; runId: string }> = [];
  let reads = 0;
  const result = await cancelAcceptedRemoteTurn(defaultReceipt, {
    dequeue: async () => ({
      client_message_id: receipt.client_message_id,
      status: "too_late",
    }),
    exact: async () =>
      ++reads === 1
        ? exact({ run_ids: ["run-own"] })
        : exact({
            status: "CAN",
            cancelled_at: "now",
            run_ids: ["run-own"],
          }),
    cancelRun: async (agentId, runId) => {
      cancelled.push({ agentId, runId });
      return { [runId]: "cancelled" };
    },
    retrieveRun: async (runId) => terminalRun(runId),
    runtimeStatus: async () => ({
      ...inactiveRuntime(),
      statuses: [
        {
          ...runtimeEntry(),
          conversation_id: "default",
        },
      ],
    }),
    sleep: async () => {},
    timeoutMs: 100,
  });

  expect(result).toEqual({ status: "confirmed" });
  expect(cancelled).toEqual([{ agentId: receipt.agent_id, runId: "run-own" }]);
});

test("already_dequeued without an exact run ID remains explicitly unconfirmed", async () => {
  const result = await cancelAcceptedRemoteTurn(receipt, {
    dequeue: async () => ({
      client_message_id: receipt.client_message_id,
      status: "already_dequeued",
    }),
    exact: async () => exact(),
    cancelRun: async () => {
      throw new Error("must not cancel all runs");
    },
    retrieveRun: async (runId) => terminalRun(runId),
    runtimeStatus: async () => inactiveRuntime(),
    sleep: async () => {},
    timeoutMs: 20,
  });

  expect(result.status).toBe("unconfirmed");
  if (result.status === "unconfirmed") {
    expect(result.detail).toContain(receipt.super_run_id);
    expect(result.detail).toContain("no correlated run ID");
  }
});

test("a cancelled run that remains active in the runtime is unconfirmed", async () => {
  const result = await cancelAcceptedRemoteTurn(receipt, {
    dequeue: async () => ({
      client_message_id: receipt.client_message_id,
      status: "too_late",
    }),
    exact: async () =>
      exact({ status: "CAN", cancelled_at: "now", run_ids: ["run-own"] }),
    cancelRun: async () => {},
    cancelConversationRun: async (_conversationId, runId) => ({
      [runId]: "cancelled",
    }),
    retrieveRun: async (runId) => terminalRun(runId),
    runtimeStatus: async () => ({
      ...inactiveRuntime(),
      statuses: [
        {
          ...runtimeEntry(),
          state: "ACTIVE" as const,
          active_run_ids: ["run-own", "run-unrelated"],
        },
      ],
    }),
    sleep: async () => {},
    timeoutMs: 20,
  });

  expect(result).toEqual({
    status: "unconfirmed",
    detail:
      "Remote cancellation unconfirmed for accepted Super Run super-run-accepted: the accepted Super Run settled but its correlated run is still active in the runtime.",
  });
});

test("a terminal Super Run without run IDs is unconfirmed while the conversation has unattributed activity", async () => {
  const result = await cancelAcceptedRemoteTurn(receipt, {
    dequeue: async () => ({
      client_message_id: receipt.client_message_id,
      status: "dequeued",
    }),
    exact: async () => exact({ status: "CAN", cancelled_at: "now" }),
    cancelRun: async () => {},
    retrieveRun: async (runId) => terminalRun(runId),
    runtimeStatus: async () => ({
      ...inactiveRuntime(),
      statuses: [
        {
          ...runtimeEntry(),
          state: "ACTIVE_UNATTRIBUTED" as const,
          active_run_ids: ["run-unknown"],
        },
      ],
    }),
    sleep: async () => {},
    timeoutMs: 20,
  });

  expect(result.status).toBe("unconfirmed");
  if (result.status === "unconfirmed")
    expect(result.detail).toContain("target conversation is inactive");
});

test("an exact Super Run 404 is unconfirmed without authoritative dequeue proof", async () => {
  let reads = 0;
  const result = await cancelAcceptedRemoteTurn(receipt, {
    dequeue: async () => ({
      client_message_id: receipt.client_message_id,
      status: "already_dequeued",
    }),
    exact: async () => {
      reads++;
      throw new ApiRequestError("not found", 404, "not found");
    },
    cancelRun: async () => {},
    retrieveRun: async (runId) => terminalRun(runId),
    runtimeStatus: async () => inactiveRuntime(),
    sleep: async () => {},
    timeoutMs: 20,
  });

  expect(result.status).toBe("unconfirmed");
  expect(reads).toBeGreaterThan(1);
  if (result.status === "unconfirmed")
    expect(result.detail).toContain("not found");
});

test("a rejected exact cancellation is retried for the same run ID", async () => {
  const defaultReceipt = { ...receipt, conversation_id: "default" };
  let requests = 0;
  const result = await cancelAcceptedRemoteTurn(defaultReceipt, {
    dequeue: async () => ({
      client_message_id: receipt.client_message_id,
      status: "too_late",
    }),
    exact: async () => exact({ run_ids: ["run-own"] }),
    cancelRun: async () => {
      requests++;
      throw new Error("temporary cancellation failure");
    },
    retrieveRun: async (runId) => terminalRun(runId),
    runtimeStatus: async () => inactiveRuntime(),
    sleep: async () => {},
    timeoutMs: 20,
  });

  expect(result.status).toBe("unconfirmed");
  expect(requests).toBeGreaterThan(1);
});

test("a fulfilled cancellation response marked failed is retried", async () => {
  const defaultReceipt = { ...receipt, conversation_id: "default" };
  let requests = 0;
  const result = await cancelAcceptedRemoteTurn(defaultReceipt, {
    dequeue: async () => ({
      client_message_id: receipt.client_message_id,
      status: "too_late",
    }),
    exact: async () => exact({ run_ids: ["run-own"] }),
    cancelRun: async () => {
      requests++;
      return { "run-own": "failed" };
    },
    retrieveRun: async (runId) => terminalRun(runId),
    runtimeStatus: async () => inactiveRuntime(),
    sleep: async () => {},
    timeoutMs: 20,
  });

  expect(result.status).toBe("unconfirmed");
  expect(requests).toBeGreaterThan(1);
});

test("a child run 404 is not terminal proof for an accepted receipt", async () => {
  const defaultReceipt = { ...receipt, conversation_id: "default" };
  const result = await cancelAcceptedRemoteTurn(defaultReceipt, {
    dequeue: async () => ({
      client_message_id: receipt.client_message_id,
      status: "too_late",
    }),
    exact: async () =>
      exact({ status: "CAN", cancelled_at: "now", run_ids: ["run-own"] }),
    cancelRun: async (_agentId, runId) => ({ [runId]: "cancelled" }),
    retrieveRun: async () => {
      throw new ApiRequestError("not found", 404, "not found");
    },
    runtimeStatus: async () => inactiveRuntime(),
    sleep: async () => {},
    timeoutMs: 20,
  });

  expect(result.status).toBe("unconfirmed");
  if (result.status === "unconfirmed")
    expect(result.detail).toContain("correlated run is still non-terminal");
});
