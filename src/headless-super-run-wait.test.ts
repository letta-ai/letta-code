import { expect, test } from "bun:test";
import type { Message } from "@letta-ai/letta-client/resources/agents/messages";
import type {
  AcceptedSuperRun,
  EnqueueReceipt,
} from "@/backend/api/conversation-enqueue";
import { waitForAcceptedSuperRun } from "./headless-super-run-wait";

const receipt: EnqueueReceipt = {
  status: "queued",
  agent_id: "agent-1",
  conversation_id: "conv-1",
  client_message_id: "cm-1",
  super_run_id: "sr-1",
  workflow_id: "wf-1",
};
function completed(extra: Partial<AcceptedSuperRun> = {}): AcceptedSuperRun {
  return {
    id: "sr-1",
    agent_id: "agent-1",
    conversation_id: "conv-1",
    status: "COM",
    completed_at: "2026-09-15T00:00:00Z",
    cancelled_at: null,
    errored_at: null,
    run_ids: ["run-1"],
    turn_finished: { run_id: "run-1", stop_reason: "end_turn" },
    ...extra,
  };
}
const messages = async (): Promise<Message[]> => [
  {
    id: "msg-1",
    date: "2026-09-15T00:00:00Z",
    message_type: "assistant_message",
    content: "Finished",
    seq_id: 1,
  },
];

test("reads an already-finished exact send without an active-status stream", async () => {
  const reply = await waitForAcceptedSuperRun(
    receipt,
    new AbortController().signal,
    {
      retrieve: async (input) => {
        expect(input).toBe(receipt);
        return completed();
      },
      messages,
    },
  );
  expect(reply.text).toBe("Finished");
});

test("temporary read failure retries the receipt, never the input", async () => {
  let reads = 0;
  const reply = await waitForAcceptedSuperRun(
    receipt,
    new AbortController().signal,
    {
      retrieve: async () => {
        if (++reads === 1) throw new Error("fetch failed");
        return completed();
      },
      messages,
      pollMs: 1,
    },
  );
  expect(reads).toBe(2);
  expect(reply.text).toBe("Finished");
});

test("a failed model run followed by listener recovery does not fail the task", async () => {
  let reads = 0;
  let messageReads = 0;
  const reply = await waitForAcceptedSuperRun(
    receipt,
    new AbortController().signal,
    {
      retrieve: async () =>
        ++reads === 1
          ? completed({
              status: "STR",
              completed_at: null,
              run_ids: ["quota-failed-run"],
              turn_finished: null,
            })
          : completed({
              run_ids: ["quota-failed-run", "recovered-run"],
              turn_finished: {
                run_id: "recovered-run",
                stop_reason: "end_turn",
              },
            }),
      messages: async (id) => {
        expect(id).toBe("recovered-run");
        messageReads++;
        return messages();
      },
      pollMs: 1,
    },
  );
  expect(reply.text).toBe("Finished");
  expect(messageReads).toBe(1);
});

test("idle completion waits for the later listener terminal frame", async () => {
  let reads = 0;
  await expect(
    waitForAcceptedSuperRun(receipt, new AbortController().signal, {
      retrieve: async () =>
        ++reads === 1
          ? completed({ turn_finished: null })
          : completed({
              turn_finished: { run_id: "run-1", stop_reason: "max_steps" },
            }),
      messages: async () => {
        throw new Error("must not read a successful reply");
      },
      pollMs: 1,
    }),
  ).rejects.toThrow("max_steps");
  expect(reads).toBe(2);
});

test("terminal without listener evidence is unknown, never successful", async () => {
  let now = 0;
  await expect(
    waitForAcceptedSuperRun(receipt, new AbortController().signal, {
      retrieve: async () => {
        now += 31_000;
        return completed({ turn_finished: null });
      },
      messages,
      pollMs: 1,
      now: () => now,
    }),
  ).rejects.toThrow("Do not resend");
});

test("abort interrupts retry backoff", async () => {
  const controller = new AbortController();
  await expect(
    waitForAcceptedSuperRun(receipt, controller.signal, {
      retrieve: async () => {
        controller.abort();
        throw new Error("offline");
      },
      messages,
    }),
  ).rejects.toThrow();
});
