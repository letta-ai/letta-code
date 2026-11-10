import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import {
  getPreStreamErrorAction,
  resumeConversationBusyRequest,
  waitForConversationBusyRun,
} from "@/agent/approval-recovery";
import { sendMessageStreamWithBackend } from "@/agent/message";
import { __testSetBackend, type Backend } from "@/backend/backend";
import { telemetry } from "@/telemetry";
import { __testResetBusyRecoveryBudget } from "@/telemetry/busy-recovery";

const calls: Array<{
  phase: string;
  poll_count?: number;
  elapsed_ms?: number;
}> = [];
let statuses: Array<number | undefined> = [];
const spy = spyOn(telemetry, "trackError").mockImplementation(
  (_type, _message, context, options) => {
    calls.push(JSON.parse(context ?? "{}"));
    statuses.push(options?.httpStatus);
  },
);
afterEach(() => {
  calls.length = 0;
  statuses = [];
  __testSetBackend(null);
});

describe("busy recovery diagnostic boundaries", () => {
  test("retry selection and budget exhaustion preserve the policy decision", () => {
    const detail =
      "Cannot send a new message: Another request (run_id=run-blocker) is currently being processed for this conversation.";
    expect(getPreStreamErrorAction(detail, 0, 3)).toBe(
      "retry_conversation_busy",
    );
    expect(calls.at(-1)).toMatchObject({
      phase: "retry_selected",
      retry_count: 0,
    });
    expect(getPreStreamErrorAction(detail, 3, 3)).toBe("rethrow");
    expect(calls.at(-1)).toMatchObject({
      phase: "retry_budget_exhausted",
      retry_count: 3,
    });
    const count = calls.length;
    expect(getPreStreamErrorAction("unrelated error", 0, 3)).toBe("rethrow");
    expect(calls).toHaveLength(count);
  });

  test("busy send rejection correlates request OTID with the different blocker", async () => {
    const error = {
      status: 409,
      error: {
        detail:
          "Cannot send a new message: Another request (run_id=run-blocker) is currently being processed for this conversation.",
      },
    };
    const backend = {
      createConversationMessageStream: async () => {
        throw error;
      },
    } as unknown as Backend;
    await expect(
      sendMessageStreamWithBackend(
        backend,
        "conv-example",
        [{ role: "user", content: "secret prompt", otid: "otid-example" }],
        {
          skillSources: [],
          preparedToolContext: {
            contextId: "ctx-example",
            clientTools: [],
            loadedToolNames: [],
          },
        },
        { maxRetries: 0 },
      ),
    ).rejects.toBe(error);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      phase: "send_rejected",
      conversation_id: "conv-example",
      request_otid: "otid-example",
      blocker_run_id: "run-blocker",
    });
    expect(statuses).toEqual([409]);
    expect(JSON.stringify(calls)).not.toContain("secret");
  });

  test("records status failure with no error message and preserves fallback", async () => {
    const result = await waitForConversationBusyRun("run-example", undefined, {
      now: () => 0,
      retrieveRun: async () => {
        throw Object.assign(new Error("secret body"), { status: 503 });
      },
    });
    expect(result).toBe("unavailable");
    expect(calls.map((c) => c.phase)).toEqual(["poll_started", "poll_failed"]);
    expect(calls[1]?.poll_count).toBe(1);
    expect(statuses).toEqual([undefined, 503]);
    expect(JSON.stringify(calls)).not.toContain("secret");
  });

  test("records timeout across active polls without changing the deadline", async () => {
    let now = 0;
    expect(
      await waitForConversationBusyRun("run-example", undefined, {
        now: () => now,
        deadlineMs: 3,
        pollIntervalMs: 2,
        retrieveRun: async () => ({ status: "running" }),
        sleep: async (delay) => {
          now += delay;
        },
      }),
    ).toBe("timed_out");
    expect(calls.at(-1)).toMatchObject({
      phase: "poll_timed_out",
      poll_count: 2,
      elapsed_ms: 3,
    });
  });

  test("records settled, unknown status and cancellation distinctly", async () => {
    await waitForConversationBusyRun("run-example", undefined, {
      retrieveRun: async () => ({ status: "completed" }),
      sleep: async () => {},
    });
    expect(calls.at(-1)?.phase).toBe("poll_settled");
    await waitForConversationBusyRun("run-example", undefined, {
      retrieveRun: async () => ({ status: "secret unknown status" }),
    });
    expect(calls.at(-1)?.phase).toBe("poll_unknown_status");
    const controller = new AbortController();
    await expect(
      waitForConversationBusyRun("run-example", controller.signal, {
        retrieveRun: async () => {
          controller.abort();
          throw new Error("secret");
        },
      }),
    ).rejects.toThrow();
    expect(calls.at(-1)?.phase).toBe("cancelled");
    expect(JSON.stringify(calls)).not.toContain("secret");
  });

  test("own-OTID 404 reports unavailable and keeps the rejected input", async () => {
    const input = [
      {
        type: "message" as const,
        role: "user" as const,
        content: "secret prompt",
        otid: "otid-example",
      },
    ];
    __testSetBackend({
      streamConversationMessages: async (
        _id: string,
        body: Parameters<Backend["streamConversationMessages"]>[1],
      ) => {
        expect(body?.otid).toBe("otid-example");
        throw Object.assign(new Error("secret server detail"), { status: 404 });
      },
    } as unknown as Backend);
    expect(
      await resumeConversationBusyRequest("conv-example", undefined, input),
    ).toBeNull();
    expect(calls.map((c) => c.phase)).toEqual([
      "replay_started",
      "replay_unavailable",
    ]);
    expect(statuses).toEqual([undefined, 404]);
    expect(input[0]?.otid).toBe("otid-example");
    expect(JSON.stringify(calls)).not.toContain("secret");
  });
});

// Restore the process-local spy after this file finishes.

afterAll(() => spy.mockRestore());

const originalTelemetryEnv = process.env.LETTA_CODE_TELEM;
const originalDoNotTrack = process.env.DO_NOT_TRACK;
beforeEach(() => {
  __testResetBusyRecoveryBudget();
  process.env.LETTA_CODE_TELEM = "1";
  delete process.env.DO_NOT_TRACK;
});
afterEach(() => {
  if (originalTelemetryEnv === undefined) delete process.env.LETTA_CODE_TELEM;
  else process.env.LETTA_CODE_TELEM = originalTelemetryEnv;
  if (originalDoNotTrack === undefined) delete process.env.DO_NOT_TRACK;
  else process.env.DO_NOT_TRACK = originalDoNotTrack;
});
