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
    latest: async () => row(),
    open: async () => events(snapshot(), snapshot(false)),
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

test("existing active-to-idle feed yields one completion and collects an observed reply", async () => {
  const result = await waitForAcceptedSuperRun(
    receipt,
    new AbortController().signal,
    deps(),
  );
  expect(result.text).toBe("Done");
  expect(result.runIds).toEqual(["run-1"]);
});
test("fast completion before subscription still produces a notification without a mandatory reply", async () => {
  const result = await waitForAcceptedSuperRun(
    receipt,
    new AbortController().signal,
    deps({
      latest: async () => row("COM"),
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
      latest: async () => {
        if (++reads === 1) throw new Error("fetch failed");
        return row();
      },
      open: async () =>
        events(
          snapshot(true, "quota-failed"),
          snapshot(true, "recovered"),
          snapshot(false),
        ),
      messages: async (id) => {
        expect(id).toBe("recovered");
        return [];
      },
    }),
  );
  expect(reads).toBeGreaterThan(1);
  expect(result.runIds).toEqual(["quota-failed", "recovered"]);
});
test("default conversation completes from its existing Cloud snapshot, without unsupported GET", async () => {
  const result = await waitForAcceptedSuperRun(
    { ...receipt, conversation_id: "default" },
    new AbortController().signal,
    deps({
      latest: async () => {
        throw new Error("unsupported default GET");
      },
      open: async () => events(snapshot(false)),
    }),
  );
  expect(result.text).toContain("--conversation default");
});
test("a newer send does not make us wait on unrelated work or collect its messages", async () => {
  const result = await waitForAcceptedSuperRun(
    receipt,
    new AbortController().signal,
    deps({
      latest: async () => ({ ...row(), id: "newer-send" }),
      open: async () => events(snapshot(false)),
      messages: async () => {
        throw new Error("must not read unrelated messages");
      },
    }),
  );
  expect(result.runIds).toEqual([]);
});
test("dropped stream reconnects and preserves observed run mappings", async () => {
  let opens = 0;
  const result = await waitForAcceptedSuperRun(
    receipt,
    new AbortController().signal,
    deps({
      open: async () =>
        ++opens === 1 ? events(snapshot()) : events(snapshot(false)),
    }),
  );
  expect(opens).toBe(2);
  expect(result.text).toBe("Done");
});
test("explicit terminal cancellation is reported", async () => {
  await expect(
    waitForAcceptedSuperRun(
      receipt,
      new AbortController().signal,
      deps({ latest: async () => row("CAN") }),
    ),
  ).rejects.toThrow("cancelled");
});
test("abort interrupts background retries", async () => {
  const controller = new AbortController();
  await expect(
    waitForAcceptedSuperRun(
      receipt,
      controller.signal,
      deps({
        latest: async () => {
          controller.abort();
          throw new Error("offline");
        },
      }),
    ),
  ).rejects.toThrow();
});
