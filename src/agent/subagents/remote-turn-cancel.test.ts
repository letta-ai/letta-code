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
  { name: "cloud-only (no listener receipt)", connection_id: undefined },
])(
  "$name non-default execution is only confirmed after it becomes terminal",
  async (variant) => {
    const scopedReceipt = { ...receipt, connection_id: variant.connection_id };
    const cancellationRequests: Array<{
      conversationId: string;
      runId: string;
    }> = [];
    const listenerAborts: string[] = [];
    let listenerSettled = false;
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
      abortListenerRun: async (_receipt, runId) => {
        listenerAborts.push(runId);
        listenerSettled = true;
        return true;
      },
      retrieveRun: async (runId) => terminalRun(runId),
      runtimeStatus: async () =>
        variant.connection_id && !listenerSettled
          ? {
              ...inactiveRuntime(),
              statuses: [
                {
                  ...runtimeEntry(),
                  state: "ACTIVE" as const,
                  active_harness: { connection_id: variant.connection_id },
                  active_run_ids: ["run-own"],
                },
              ],
            }
          : inactiveRuntime(),
      sleep: async () => {},
      timeoutMs: 100,
    });

    expect(result).toEqual({ status: "confirmed" });
    expect(cancellationRequests).toEqual([
      { conversationId: receipt.conversation_id, runId: "run-own" },
    ]);
    expect(listenerAborts).toEqual(variant.connection_id ? ["run-own"] : []);
  },
);

test("listener-owned cancellation waits for local lease settlement as well as Cloud terminal state", async () => {
  let releaseListener!: () => void;
  const listenerSettled = new Promise<void>((resolve) => {
    releaseListener = resolve;
  });
  let completed = false;
  let listenerReleased = false;
  const cancellation = cancelAcceptedRemoteTurn(
    { ...receipt, connection_id: "listener-1" },
    {
      dequeue: async () => ({
        client_message_id: receipt.client_message_id,
        status: "too_late",
      }),
      exact: async () =>
        exact({ status: "CAN", cancelled_at: "now", run_ids: ["run-own"] }),
      abortListenerRun: async (_receipt, runId) => {
        expect(runId).toBe("run-own");
        await listenerSettled;
        listenerReleased = true;
        return true;
      },
      cancelConversationRun: async (_conversationId, runId) => ({
        [runId]: "cancelled",
      }),
      retrieveRun: async (runId) => terminalRun(runId),
      runtimeStatus: async () =>
        listenerReleased
          ? inactiveRuntime()
          : {
              ...inactiveRuntime(),
              statuses: [
                {
                  ...runtimeEntry(),
                  state: "ACTIVE" as const,
                  active_harness: { connection_id: "listener-1" },
                  active_run_ids: ["run-own"],
                },
              ],
            },
      sleep: async () => {},
      timeoutMs: 1_000,
    },
  ).then((result) => {
    completed = true;
    return result;
  });

  await Bun.sleep(5);
  expect(completed).toBe(false);
  releaseListener();
  expect(await cancellation).toEqual({ status: "confirmed" });
});

test("a vanished listener without lease settlement remains unconfirmed", async () => {
  let reads = 0;
  const result = await cancelAcceptedRemoteTurn(
    { ...receipt, connection_id: "listener-1" },
    {
      dequeue: async () => ({
        client_message_id: receipt.client_message_id,
        status: "too_late",
      }),
      exact: async () =>
        exact({ status: "CAN", cancelled_at: "now", run_ids: ["run-own"] }),
      runtimeStatus: async () => {
        const firstRead = ++reads === 1;
        return {
          ...inactiveRuntime(),
          statuses: [
            {
              ...runtimeEntry(),
              state: firstRead ? ("ACTIVE" as const) : ("IDLE" as const),
              active_harness: firstRead
                ? { connection_id: "listener-1" }
                : null,
              active_run_ids: firstRead ? ["run-own"] : [],
            },
          ],
        };
      },
      abortListenerRun: async () => false,
      cancelConversationRun: async (_conversationId, runId) => ({
        [runId]: "cancelled",
      }),
      retrieveRun: async (runId) => terminalRun(runId),
      sleep: async () => {
        throw new Error("first observation complete");
      },
      timeoutMs: 1_000,
    },
  );

  expect(reads).toBe(2);
  expect(result.status).toBe("unconfirmed");
});

test("only the currently owned continuation is listener-aborted in a multi-run accepted turn", async () => {
  const aborted: string[] = [];
  let settled = false;
  const result = await cancelAcceptedRemoteTurn(
    { ...receipt, connection_id: "listener-1" },
    {
      dequeue: async () => ({
        client_message_id: receipt.client_message_id,
        status: "too_late",
      }),
      exact: async () =>
        exact({
          status: "CAN",
          cancelled_at: "now",
          run_ids: ["run-history", "run-current"],
        }),
      abortListenerRun: async (_receipt, runId) => {
        aborted.push(runId);
        settled = true;
        return true;
      },
      cancelConversationRun: async (_conversationId, runId) => ({
        [runId]: "cancelled",
      }),
      retrieveRun: async (runId) => terminalRun(runId),
      runtimeStatus: async () => ({
        ...inactiveRuntime(),
        statuses: [
          settled
            ? runtimeEntry()
            : {
                ...runtimeEntry(),
                state: "ACTIVE" as const,
                active_harness: { connection_id: "listener-1" },
                active_run_ids: ["run-current"],
              },
        ],
      }),
      sleep: async () => {},
      timeoutMs: 100,
    },
  );

  expect(result).toEqual({ status: "confirmed" });
  expect(aborted).toEqual(["run-current"]);
});

test("a missing harness is not proof the receipt listener let go", async () => {
  // Core shows the run terminal and no harness, but the listener that accepted
  // the input may be reconnecting with its lease and client tool preserved.
  const asked: string[] = [];
  const result = await cancelAcceptedRemoteTurn(
    { ...receipt, connection_id: "disconnected-listener" },
    {
      dequeue: async () => ({
        client_message_id: receipt.client_message_id,
        status: "too_late",
      }),
      exact: async () =>
        exact({ status: "CAN", cancelled_at: "now", run_ids: ["run-own"] }),
      abortListenerRun: async (_receipt, runId) => {
        asked.push(runId);
        throw new Error("listener unreachable");
      },
      cancelConversationRun: async (_conversationId, runId) => ({
        [runId]: "cancelled",
      }),
      retrieveRun: async (runId) => terminalRun(runId),
      runtimeStatus: async () => inactiveRuntime(),
      sleep: async () => {},
      timeoutMs: 100,
    },
  );

  expect(asked.length).toBeGreaterThan(0);
  expect(asked.every((runId) => runId === "run-own")).toBe(true);
  expect(result.status).toBe("unconfirmed");
});

test("a reconnected listener that settles the preserved lease confirms", async () => {
  // Disconnect: first snapshot has no harness. Reconnect: the same listener
  // answers the exact abort with a settled lease, so TaskStop can confirm.
  let reconnected = false;
  const result = await cancelAcceptedRemoteTurn(
    { ...receipt, connection_id: "listener-1" },
    {
      dequeue: async () => ({
        client_message_id: receipt.client_message_id,
        status: "too_late",
      }),
      exact: async () =>
        exact({ status: "CAN", cancelled_at: "now", run_ids: ["run-own"] }),
      abortListenerRun: async (_receipt, runId) => {
        expect(runId).toBe("run-own");
        if (!reconnected) {
          reconnected = true;
          throw new Error("listener reconnecting");
        }
        return true;
      },
      cancelConversationRun: async (_conversationId, runId) => ({
        [runId]: "cancelled",
      }),
      retrieveRun: async (runId) => terminalRun(runId),
      runtimeStatus: async () => inactiveRuntime(),
      sleep: async () => {},
      timeoutMs: 1_000,
    },
  );

  expect(reconnected).toBe(true);
  expect(result).toEqual({ status: "confirmed" });
});

test("a replaced owner releases the old receipt listener", async () => {
  const result = await cancelAcceptedRemoteTurn(
    { ...receipt, connection_id: "old-listener" },
    {
      dequeue: async () => ({
        client_message_id: receipt.client_message_id,
        status: "too_late",
      }),
      exact: async () =>
        exact({ status: "CAN", cancelled_at: "now", run_ids: ["run-own"] }),
      abortListenerRun: async () => {
        throw new Error("must not contact a replaced owner");
      },
      cancelConversationRun: async (_conversationId, runId) => ({
        [runId]: "cancelled",
      }),
      retrieveRun: async (runId) => terminalRun(runId),
      runtimeStatus: async () => ({
        ...inactiveRuntime(),
        statuses: [
          {
            ...runtimeEntry(),
            active_harness: { connection_id: "new-listener" },
          },
        ],
      }),
      sleep: async () => {},
      timeoutMs: 100,
    },
  );

  expect(result).toEqual({ status: "confirmed" });
});

test("a takeover after the disconnect window releases the old listener", async () => {
  // Poll 1: no harness, so the receipt listener must settle run-own. Poll 2: a
  // different connection owns the conversation, which proves the old listener
  // is out even though it never answered.
  let reads = 0;
  const result = await cancelAcceptedRemoteTurn(
    { ...receipt, connection_id: "old-listener" },
    {
      dequeue: async () => ({
        client_message_id: receipt.client_message_id,
        status: "too_late",
      }),
      exact: async () =>
        exact({ status: "CAN", cancelled_at: "now", run_ids: ["run-own"] }),
      abortListenerRun: async () => {
        throw new Error("old listener unreachable");
      },
      cancelConversationRun: async (_conversationId, runId) => ({
        [runId]: "cancelled",
      }),
      retrieveRun: async (runId) => terminalRun(runId),
      runtimeStatus: async () => {
        reads += 1;
        return reads <= 2
          ? inactiveRuntime()
          : {
              ...inactiveRuntime(),
              statuses: [
                {
                  ...runtimeEntry(),
                  active_harness: { connection_id: "new-listener" },
                },
              ],
            };
      },
      sleep: async () => {},
      timeoutMs: 1_000,
    },
  );

  expect(reads).toBeGreaterThan(2);
  expect(result).toEqual({ status: "confirmed" });
});

test("a stalled ownership lookup cannot prevent exact Cloud cancellation", async () => {
  const cancelled: string[] = [];
  const result = await cancelAcceptedRemoteTurn(
    { ...receipt, connection_id: "listener-1" },
    {
      dequeue: async () => ({
        client_message_id: receipt.client_message_id,
        status: "too_late",
      }),
      exact: async () => exact({ run_ids: ["run-own"] }),
      runtimeStatus: async () =>
        new Promise<ReturnType<typeof inactiveRuntime>>(() => {}),
      cancelConversationRun: async (_conversationId, runId) => {
        cancelled.push(runId);
        return { [runId]: "cancelled" };
      },
      sleep: async () => {},
      timeoutMs: 1_000,
    },
  );

  expect(cancelled).toEqual(["run-own"]);
  expect(result.status).toBe("unconfirmed");
});

test("a pre-cancel inactive snapshot is not terminal proof", async () => {
  let statusReads = 0;
  const result = await cancelAcceptedRemoteTurn(
    { ...receipt, connection_id: "listener-1" },
    {
      dequeue: async () => ({
        client_message_id: receipt.client_message_id,
        status: "too_late",
      }),
      exact: async () =>
        exact({ status: "CAN", cancelled_at: "now", run_ids: ["run-own"] }),
      runtimeStatus: async () =>
        ++statusReads === 1
          ? inactiveRuntime()
          : {
              ...inactiveRuntime(),
              statuses: [
                {
                  ...runtimeEntry(),
                  state: "ACTIVE" as const,
                  active_run_ids: ["run-own"],
                },
              ],
            },
      cancelConversationRun: async (_conversationId, runId) => ({
        [runId]: "cancelled",
      }),
      retrieveRun: async (runId) => terminalRun(runId),
      sleep: async () => {
        throw new Error("first observation complete");
      },
      timeoutMs: 1_000,
    },
  );

  expect(statusReads).toBe(2);
  expect(result.status).toBe("unconfirmed");
});

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
    // Stop after observing activity instead of racing a tiny wall-clock budget.
    sleep: async () => {
      throw new Error("first status observation complete");
    },
    timeoutMs: 5_000,
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

test("a Cloud relay that settles the listener first still credits the direct abort", async () => {
  // C1 (exact Cloud cancel, relayed to the listener by Cloud) lands before C2
  // (TaskStop's direct listener abort). The listener answers C2 with
  // joined/already_settled plus lease_settled, so TaskStop can confirm.
  const order: string[] = [];
  let reads = 0;
  const listenerActive = () => !order.includes("listener");
  const result = await cancelAcceptedRemoteTurn(
    { ...receipt, connection_id: "listener-1" },
    {
      dequeue: async () => ({
        client_message_id: receipt.client_message_id,
        status: "too_late",
      }),
      exact: async () =>
        ++reads === 1
          ? exact({ run_ids: ["run-own"] })
          : exact({ status: "CAN", cancelled_at: "now", run_ids: ["run-own"] }),
      cancelConversationRun: async (_conversationId, runId) => {
        order.push("cloud");
        return { [runId]: "cancelled" };
      },
      runtimeStatus: async () =>
        listenerActive()
          ? {
              ...inactiveRuntime(),
              statuses: [
                {
                  ...runtimeEntry(),
                  state: "ACTIVE" as const,
                  active_harness: { connection_id: "listener-1" },
                  active_run_ids: ["run-own"],
                },
              ],
            }
          : inactiveRuntime(),
      abortListenerRun: async (_receipt, runId) => {
        order.push("listener");
        expect(runId).toBe("run-own");
        return true;
      },
      retrieveRun: async (runId) => terminalRun(runId),
      sleep: async () => {},
      timeoutMs: 1_000,
    },
  );

  expect(order).toEqual(["cloud", "listener"]);
  expect(result).toEqual({ status: "confirmed" });
});
