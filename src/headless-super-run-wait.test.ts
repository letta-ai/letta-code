import { expect, test } from "bun:test";
import type { Run } from "@letta-ai/letta-client/resources/agents/messages";
import type {
  EnqueueReceipt,
  ExactSuperRun,
} from "@/backend/api/conversation-enqueue";
import { ApiRequestError } from "@/backend/api/request";
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

function exact(status = "COM"): ExactSuperRun {
  return {
    id: "sr-1",
    status,
    completed_at: status === "COM" ? "now" : null,
    cancelled_at: status === "CAN" ? "now" : null,
    errored_at: null,
    error: null,
    run_ids: ["run-1"],
  };
}

function run(status = "completed", stopReason = "end_turn"): Run {
  return {
    id: "run-1",
    status,
    stop_reason: stopReason,
  } as Run;
}

function makeClock() {
  let time = 0;
  return {
    now: () => time,
    sleep: async (ms: number) => {
      time += Math.max(ms, 1);
    },
  };
}

function deps(extra: Partial<SuperRunWaitDeps> = {}): SuperRunWaitDeps {
  return {
    exact: async () => exact(),
    run: async () => run(),
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

test("requires the exact accepted Super Run and its newest child run", async () => {
  const reads: string[] = [];
  const result = await waitForAcceptedSuperRun(
    receipt,
    new AbortController().signal,
    deps({
      exact: async (agentId, superRunId) => {
        reads.push(`${agentId}:${superRunId}`);
        return { ...exact(), run_ids: ["run-2", "run-1"] };
      },
      run: async (runId) => {
        reads.push(runId);
        return { ...run(), id: runId } as Run;
      },
      messages: async (runId) => {
        reads.push(`messages:${runId}`);
        return [];
      },
    }),
  );
  expect(reads).toEqual(["agent-1:sr-1", "run-2", "messages:run-2"]);
  expect(result.runIds).toEqual(["run-2", "run-1"]);
  expect(result.stopReason).toBe("end_turn");
});

test("a successful child run does not require an assistant message", async () => {
  const result = await waitForAcceptedSuperRun(
    receipt,
    new AbortController().signal,
    deps({ messages: async () => [] }),
  );
  expect(result.text).toContain("Remote task finished");
  expect(result.text).toContain("letta messages list");
});

test("returns assistant text when it is available", async () => {
  const result = await waitForAcceptedSuperRun(
    receipt,
    new AbortController().signal,
    deps(),
  );
  expect(result.text).toBe("Done");
});

test("reports the stored listener pre-run failure stage", async () => {
  await expect(
    waitForAcceptedSuperRun(
      receipt,
      new AbortController().signal,
      deps({
        exact: async () => ({
          ...exact(),
          errored_at: "now",
          error: {
            code: "LISTENER_TURN_FAILED_BEFORE_RUN",
            message: "Message author is not authorized",
          },
          run_ids: [],
        }),
      }),
    ),
  ).rejects.toThrow(
    "LISTENER_TURN_FAILED_BEFORE_RUN: Message author is not authorized",
  );
});

test("reports cancellation of the exact accepted send", async () => {
  await expect(
    waitForAcceptedSuperRun(
      receipt,
      new AbortController().signal,
      deps({ exact: async () => exact("CAN") }),
    ),
  ).rejects.toThrow("Super Run sr-1 was cancelled");
});

test("retries a transient Cloud read without resubmitting", async () => {
  let reads = 0;
  const result = await waitForAcceptedSuperRun(
    receipt,
    new AbortController().signal,
    deps({
      exact: async () => {
        if (++reads === 1)
          throw new ApiRequestError("unavailable", 503, "unavailable");
        return exact();
      },
      sleep: async () => {},
    }),
  );
  expect(reads).toBe(2);
  expect(result.text).toBe("Done");
});

test("a permanent Cloud read failure is terminal", async () => {
  let reads = 0;
  await expect(
    waitForAcceptedSuperRun(
      receipt,
      new AbortController().signal,
      deps({
        exact: async () => {
          reads++;
          throw new ApiRequestError("not found", 404, "not found");
        },
      }),
    ),
  ).rejects.toThrow(
    "Cloud status read for accepted Super Run sr-1 failed: not found",
  );
  expect(reads).toBe(1);
});

test("completion without a correlated child run is failure", async () => {
  await expect(
    waitForAcceptedSuperRun(
      receipt,
      new AbortController().signal,
      deps({ exact: async () => ({ ...exact(), run_ids: [] }) }),
    ),
  ).rejects.toThrow("without a correlated child run");
});

test("a failed child run is failure", async () => {
  await expect(
    waitForAcceptedSuperRun(
      receipt,
      new AbortController().signal,
      deps({ run: async () => run("failed", "provider_error") }),
    ),
  ).rejects.toThrow("child run run-1 failed (provider_error)");
});

test("waits for active work instead of treating time as success", async () => {
  let reads = 0;
  const result = await waitForAcceptedSuperRun(
    receipt,
    new AbortController().signal,
    deps({
      exact: async () => (++reads === 1 ? exact("STR") : exact()),
      sleep: async () => {},
    }),
  );
  expect(reads).toBe(2);
  expect(result.text).toBe("Done");
});

test("fails when a completed Super Run never gets terminal child evidence", async () => {
  const clock = makeClock();
  await expect(
    waitForAcceptedSuperRun(
      receipt,
      new AbortController().signal,
      deps({
        run: async () => run("running", ""),
        resultGraceMs: 3,
        now: clock.now,
        sleep: clock.sleep,
      }),
    ),
  ).rejects.toThrow("without terminal evidence from child run run-1");
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
          throw new TypeError("offline");
        },
      }),
    ),
  ).rejects.toThrow();
});
