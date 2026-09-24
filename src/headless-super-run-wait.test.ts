import { expect, test } from "bun:test";
import type {
  ConversationStatusEvent,
  EnqueueReceipt,
  LatestConversationSuperRun,
} from "@/backend/api/conversation-enqueue";
import {
  type SuperRunWaitDeps,
  waitForAcceptedSuperRun,
} from "./headless-super-run-wait";

const receipt: EnqueueReceipt = {
  status: "queued",
  agent_id: "agent-1",
  conversation_id: "conv-1",
  client_message_id: "cm-1",
  super_run_id: "sr-1",
  workflow_id: "wf-1",
};
function row(status = "STR"): LatestConversationSuperRun {
  return {
    id: "sr-1",
    status,
    completed_at: status === "COM" ? "now" : null,
    cancelled_at: status === "CAN" ? "now" : null,
    errored_at: null,
  };
}
function snapshot(active = true, run = "run-1"): ConversationStatusEvent {
  return {
    type: "conversation_super_run_snapshot",
    statuses: active
      ? [
          {
            conversation_id: "conv-1",
            active_super_runs: [{ id: "sr-1", status: "STR" }],
            runtime_status: {
              state: "ACTIVE",
              loop_state: {
                status: "RETRYING_API_REQUEST",
                client_message_ids_by_run_id: { [run]: ["cm-1"] },
              },
            },
          },
        ]
      : [],
  };
}
async function* events(
  ...values: Array<
    | ConversationStatusEvent
    | { type: "super_run_update"; data: LatestConversationSuperRun }
  >
) {
  for (const value of values) yield value;
}
function deps(extra: Partial<SuperRunWaitDeps> = {}): SuperRunWaitDeps {
  return {
    exact: async () => row(),
    open: async () =>
      events(snapshot(), { type: "super_run_update", data: row("COM") }),
    messages: async () => [
      {
        id: "msg-1",
        date: "now",
        message_type: "assistant_message",
        content: "Done",
        seq_id: 1,
      },
    ],
    pollMs: 1,
    ...extra,
  };
}

test("exact terminal update yields one completion and collects an observed reply", async () => {
  const result = await waitForAcceptedSuperRun(
    receipt,
    new AbortController().signal,
    deps(),
  );
  expect(result.text).toBe("Done");
  expect(result.runIds).toEqual(["run-1"]);
});
test("exact completed row before subscription produces a notification without a mandatory reply", async () => {
  const result = await waitForAcceptedSuperRun(
    receipt,
    new AbortController().signal,
    deps({
      exact: async (agentId, superRunId) => {
        expect(agentId).toBe("agent-1");
        expect(superRunId).toBe("sr-1");
        return row("COM");
      },
      open: async () => {
        throw new Error("must not subscribe");
      },
    }),
  );
  expect(result.text).toContain("Remote task finished");
  expect(result.text).toContain("letta messages list");
});
test("missing reply after completion never becomes execution failure", async () => {
  const result = await waitForAcceptedSuperRun(
    receipt,
    new AbortController().signal,
    deps({
      messages: async () => {
        throw new Error("HTTP 503");
      },
    }),
  );
  expect(result.text).toContain("reply was not collected");
});
test("transient status-read failure retries, and listener recovery remains active", async () => {
  let reads = 0;
  const result = await waitForAcceptedSuperRun(
    receipt,
    new AbortController().signal,
    deps({
      exact: async () => {
        if (++reads === 1) throw new Error("fetch failed");
        return row();
      },
      open: async () =>
        events(snapshot(true, "quota-failed"), snapshot(true, "recovered"), {
          type: "super_run_update",
          data: row("COM"),
        }),
      messages: async (id) => {
        expect(id).toBe("recovered");
        return [];
      },
    }),
  );
  expect(reads).toBeGreaterThan(1);
  expect(result.runIds).toEqual(["quota-failed", "recovered"]);
});
test("default conversation completes from the exact accepted row", async () => {
  const result = await waitForAcceptedSuperRun(
    { ...receipt, conversation_id: "default" },
    new AbortController().signal,
    deps({
      exact: async (agentId, superRunId) => {
        expect(agentId).toBe("agent-1");
        expect(superRunId).toBe("sr-1");
        return row("COM");
      },
      open: async () => {
        throw new Error("must not subscribe");
      },
    }),
  );
  expect(result.text).toContain("--conversation default");
});
test("an unrelated terminal update cannot complete the accepted send", async () => {
  const result = await waitForAcceptedSuperRun(
    receipt,
    new AbortController().signal,
    deps({
      open: async () =>
        events(
          snapshot(),
          {
            type: "super_run_update",
            data: { ...row("COM"), id: "newer-send" },
          },
          { type: "super_run_update", data: row("COM") },
        ),
    }),
  );
  expect(result.text).toBe("Done");
  expect(result.runIds).toEqual(["run-1"]);
});
test("dropped stream reconnects and preserves observed run mappings", async () => {
  let opens = 0;
  const result = await waitForAcceptedSuperRun(
    receipt,
    new AbortController().signal,
    deps({
      open: async () =>
        ++opens === 1
          ? events(snapshot())
          : events({ type: "super_run_update", data: row("COM") }),
    }),
  );
  expect(opens).toBe(2);
  expect(result.text).toBe("Done");
});
test("an empty active snapshot cannot report success without exact terminal evidence", async () => {
  const controller = new AbortController();
  let reads = 0;
  await expect(
    waitForAcceptedSuperRun(
      receipt,
      controller.signal,
      deps({
        exact: async () => {
          if (++reads === 2) controller.abort();
          return row();
        },
        open: async () => events(snapshot(false)),
        messages: async () => {
          throw new Error("must not collect a reply");
        },
      }),
    ),
  ).rejects.toThrow();
  expect(reads).toBeGreaterThan(1);
});
test("explicit terminal cancellation is reported", async () => {
  await expect(
    waitForAcceptedSuperRun(
      receipt,
      new AbortController().signal,
      deps({ exact: async () => row("CAN") }),
    ),
  ).rejects.toThrow("cancelled");
});
test("exact terminal error is reported", async () => {
  await expect(
    waitForAcceptedSuperRun(
      receipt,
      new AbortController().signal,
      deps({
        exact: async () => ({ ...row("COM"), errored_at: "now" }),
      }),
    ),
  ).rejects.toThrow("finished with an error");
});
test("a mismatched exact response cannot complete the accepted send", async () => {
  await expect(
    waitForAcceptedSuperRun(
      receipt,
      new AbortController().signal,
      deps({ exact: async () => ({ ...row("COM"), id: "another-send" }) }),
    ),
  ).rejects.toThrow("another-send");
});
test("abort interrupts background retries", async () => {
  const controller = new AbortController();
  await expect(
    waitForAcceptedSuperRun(
      receipt,
      controller.signal,
      deps({
        exact: async () => {
          controller.abort();
          throw new Error("offline");
        },
      }),
    ),
  ).rejects.toThrow();
});
