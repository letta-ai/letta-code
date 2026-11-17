import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  getPreStreamErrorAction,
  reportBusyRetryExhausted,
  resumeConversationBusyRequest,
  waitForConversationBusyRun,
} from "@/agent/approval-recovery";
import { __testSetBackend, type Backend } from "@/backend/backend";
import { type TelemetryEvent, telemetry } from "@/telemetry";
import {
  __testResetBusyRecoveryBudget,
  markBusyRequest,
  traceBusyRecoveryStream as observe,
  reportBusyRecovery as report,
} from "./busy-recovery";

const state = telemetry as unknown as { events: TelemetryEvent[] };
const env = { ...process.env };
const fetch = globalThis.fetch;
let saved: TelemetryEvent[];
let now = 0;
let flush: ReturnType<typeof spyOn>;
let time: ReturnType<typeof spyOn>;
const contexts = () =>
  state.events.map((event) => JSON.parse(event.data.context as string));
beforeEach(() => {
  saved = state.events;
  state.events = [];
  now = 0;
  __testResetBusyRecoveryBudget();
  process.env.LETTA_CODE_TELEM = "1";
  process.env.LETTA_BASE_URL = "https://api.letta.com";
  process.env.LETTA_API_KEY = "synthetic-key";
  delete process.env.DO_NOT_TRACK;
  delete process.env.LETTA_DESKTOP_MODE;
  flush = spyOn(telemetry, "flush").mockResolvedValue();
  time = spyOn(Date, "now").mockImplementation(() => now);
});
afterEach(() => {
  flush.mockRestore();
  time.mockRestore();
  state.events = saved;
  globalThis.fetch = fetch;
  __testSetBackend(null);
  for (const key of "LETTA_CODE_TELEM LETTA_BASE_URL LETTA_API_KEY DO_NOT_TRACK LETTA_DESKTOP_MODE".split(
    " ",
  )) {
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
});

test("existing HTTP path preserves safe identifiers, strips content, honors opt-out", async () => {
  flush.mockRestore();
  const receipts: Array<{ url: string; body: string }> = [];
  globalThis.fetch = (async (...[url, options]: Parameters<typeof fetch>) => {
    receipts.push({ url: String(url), body: String(options?.body) });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  report("send_rejected", {
    conversationId: "conv",
    otid: "request",
    blockerRunId: "run-blocker",
    httpStatus: 409,
    requestRunId: "invalid secret id",
    lastChunkType: "secret content",
    stopReason: { secret: "body" },
  });
  expect(contexts()[0]).toMatchObject({
    request_otid: "request",
    blocker_run_id: "run-blocker",
  });
  process.env.DO_NOT_TRACK = "1";
  report("poll_started");
  await telemetry.flush();
  expect(receipts).toHaveLength(0);
  delete process.env.DO_NOT_TRACK;
  process.env.LETTA_CODE_TELEM = "0";
  report("poll_started");
  await telemetry.flush();
  expect(receipts).toHaveLength(0);
  process.env.LETTA_CODE_TELEM = "1";
  await telemetry.flush();
  expect(state.events).toHaveLength(0);
  expect(new URL(receipts[0]?.url ?? "").pathname).toBe(
    "/v1/metadata/telemetry",
  );
  const payload = JSON.parse(receipts[0]?.body ?? "");
  expect(payload.service).toBe("letta-code");
  expect(payload.events[0].type).toBe("error");
  expect(payload.events[0].data.version).toBeString();
  expect(payload.events[0].data.surface).toBeString();
  expect(payload.events[0].data).not.toHaveProperty("debug_log_tail");
  expect(receipts[0]?.body).not.toMatch(/secret|synthetic-key/);
});

test("real caller busy branches recover before reporting final exhaustion", async () => {
  const detail =
    "Another request (run_id=run-blocker) is currently being processed for this conversation. secret body";
  for (const surface of ["tui", "headless"]) {
    const source = readFileSync(
      new URL(
        surface === "tui"
          ? "../cli/app/use-conversation-loop.ts"
          : "../headless.ts",
        import.meta.url,
      ),
      "utf8",
    );
    const start = source.indexOf(
      "const blockingRunId = extractConversationBusyRunId(errorDetail);",
    );
    const end = source.indexOf(
      surface === "tui"
        ? "// Retry pre-stream transient errors"
        : 'if (preStreamAction === "retry_transient")',
      start,
    );
    const finalStart = source.indexOf(
      surface === "tui"
        ? "if (!stream) {\n              reportBusyRetryExhausted"
        : "reportBusyRetryExhausted(\n          errorDetail",
      end,
    );
    const finalEnd = source.indexOf("throw preStreamError;", finalStart);
    expect(start).toBeGreaterThan(0);
    expect(finalStart).toBeGreaterThan(end);
    // Execute the actual caller branch and final failure site, with network/UI boundaries mocked.
    const code = new Bun.Transpiler({ loader: "ts" }).transformSync(
      `async function run() { do { ${source.slice(start, end)} ${source.slice(finalStart, finalEnd + "throw preStreamError;".length)} ${surface === "tui" ? "}" : ""} return "replayed"; } while (false); return "settled"; }`,
    );
    for (const outcome of ["replayed", "settled", "unavailable"]) {
      __testResetBusyRecoveryBudget();
      state.events = [];
      const error = new Error("synthetic rejection");
      const scope = {
        errorDetail: detail,
        preStreamError: error,
        preStreamAction: getPreStreamErrorAction(detail, 3, 3),
        extractConversationBusyRunId: () => "run-blocker",
        reportBusyRetryExhausted,
        stream: undefined,
        turnToolContextId: undefined,
        conversationId: "conv",
        agent: { id: "agent" },
        currentInput: [],
        conversationIdRef: { current: "conv" },
        agentIdRef: { current: "agent" },
        conversationBusyRetriesRef: { current: 3 },
        conversationBusyRetries: 3,
        CONVERSATION_BUSY_MAX_RETRIES: 3,
        conversationBusyDeadlineMs: null,
        busyDeadline: null,
        CONVERSATION_BUSY_WAIT_TIMEOUT_MS: 300000,
        BUSY_WAIT_MS: 300000,
        signal: undefined,
        sigintSignal: undefined,
        resumeConversationBusyRequest: async () =>
          outcome === "replayed" ? {} : null,
        resumeBusy: async () => (outcome === "replayed" ? {} : null),
        waitForConversationBusyRunOrThrow: async () => outcome === "settled",
        waitForBusyRun: async () => outcome === "settled",
        buffersRef: {
          current: { byId: new Map(), order: [], interrupted: false },
        },
        telemetry: { trackError() {} },
        formatTelemetryErrorMessage: () => "",
        currentModelId: undefined,
        APIError: Error,
        debugLog() {},
        getStreamToolContextId() {},
        uid: () => "status",
        refreshDerived() {},
        myGeneration: 0,
        conversationGenerationRef: { current: 0 },
        userCancelledRef: { current: false },
        restorePinnedPermissionMode() {},
      };
      const run = new Function(
        "scope",
        `with (scope) { ${code}; return run(); }`,
      );
      if (outcome === "unavailable")
        await expect(run(scope)).rejects.toBe(error);
      else if (surface === "headless" && outcome === "replayed") {
        // Existing headless fallthrough still throws, but accepted replay must not be labelled exhausted.
        await expect(run(scope)).rejects.toBe(error);
      } else expect(await run(scope)).toBe(outcome);
      expect(
        contexts().filter((row) => row.phase === "retry_budget_exhausted"),
      ).toHaveLength(outcome === "unavailable" ? 1 : 0);
      reportBusyRetryExhausted(detail, 3, 3);
      reportBusyRetryExhausted(detail, 3, 3);
      expect(
        contexts().filter((row) => row.phase === "retry_budget_exhausted"),
      ).toHaveLength(1);
      expect(JSON.stringify(state.events)).not.toContain("secret body");
    }
  }
});

test("replay 404 and blocker failure, settlement and timeout remain distinct", async () => {
  __testSetBackend({
    streamConversationMessages: async () => {
      throw { status: 404, message: "secret" };
    },
  } as unknown as Backend);
  const input = [
    { role: "user" as const, content: "secret prompt", otid: "otid" },
  ];
  expect(
    await resumeConversationBusyRequest("conv", undefined, input),
  ).toBeNull();
  expect(state.events[0]?.data.http_status).toBe(404);
  expect(input[0]?.otid).toBe("otid");
  expect(
    await waitForConversationBusyRun("failed", undefined, {
      retrieveRun: async () => {
        throw { status: 503, message: "secret" };
      },
    }),
  ).toBe("unavailable");
  expect(
    await waitForConversationBusyRun("settled", undefined, {
      retrieveRun: async () => ({ status: "completed" }),
      sleep: async () => {},
    }),
  ).toBe("settled");
  expect(
    await waitForConversationBusyRun("timeout", undefined, {
      now: () => 1,
      deadlineMs: 0,
    }),
  ).toBe("timed_out");
  expect(contexts().map((row) => row.phase)).toEqual([
    "replay_unavailable",
    "poll_started",
    "poll_failed",
    "poll_unavailable",
    "poll_started",
    "poll_settled",
    "poll_started",
    "poll_timed_out",
  ]);
  expect(JSON.stringify(state.events)).not.toContain("secret");
});

test("retries and rotating blockers cannot crowd out bounded snapshots/outcomes or flood the queue", () => {
  for (let n = 0; n < 1000; n += 1) {
    report("send_rejected", { otid: "request", blockerRunId: `run-${n}` });
    report("poll_started", { blockerRunId: `run-${n}` });
  }
  expect(state.events).toHaveLength(2);
  for (const phase of [
    "stream_progress",
    "stream_waiting",
    "poll_timed_out",
    "stream_eof",
    "stream_failed",
  ] as const)
    report(phase, { otid: "request" });
  expect(state.events).toHaveLength(6); // Two reserved outcomes, not three.
  __testResetBusyRecoveryBudget();
  state.events = [];

  for (let n = 0; n < 1000; n += 1)
    report("send_rejected", { otid: `request-${n}` });
  expect(state.events).toHaveLength(60);
  for (let n = 0; n < 20; n += 1)
    report("stream_progress", { otid: `snapshot-${n}` });
  expect(state.events).toHaveLength(70);
  for (let n = 0; n < 20; n += 1)
    report("stream_eof", { otid: `terminal-${n}` });
  expect(state.events).toHaveLength(80);
});

test("checkpoints observe original/recovered hangs and retire 128 slots before late cleanup", async () => {
  let timers: Array<() => void> = [];
  const clock = {
    schedule: (cb: () => void) => {
      timers.push(cb);
      return () => {};
    },
  };
  const old = new AbortController();
  let returned = 0;
  const cleanups: Array<() => Promise<unknown>> = [];
  for (let n = 0; n < 128; n += 1) {
    let reads = 0;
    const backend = {};
    if (n % 4 === 2) markBusyRequest(backend, "conv-old", `otid-${n}`);
    const stream = observe(
      {
        [Symbol.asyncIterator]: () => ({
          next: async (): Promise<IteratorResult<unknown>> =>
            ++reads === 1
              ? {
                  done: false,
                  value: {
                    message_type: "reasoning_message",
                    run_id: `run-${n}`,
                    content: "secret body",
                  },
                }
              : new Promise(() => {}),
          return: async () => {
            returned += 1;
            return { done: true as const, value: undefined };
          },
        }),
      },
      "conv-old",
      `otid-${n}`,
      old.signal,
      backend,
      clock,
    );
    // Half never iterate; half wait on a genuinely unresolved second read.
    if (n % 2 === 0) {
      const reader = stream[Symbol.asyncIterator]();
      await reader.next();
      void reader.next();
      cleanups.push(() => reader.return());
    } else cleanups.push(() => stream[Symbol.asyncIterator]().return());
  }
  const fire = () => {
    const batch = timers;
    timers = [];
    for (const cb of batch) cb();
  };
  expect(timers).toHaveLength(128);
  now = 60000;
  fire();
  expect(contexts().find((r) => r.request_run_id === "run-0")).toMatchObject({
    phase: "stream_progress",
    read_pending: true,
    idle_ms: 60000,
    chunk_count: 1,
  });
  expect(contexts().some((r) => r.request_run_id === "run-2")).toBe(true);
  now = 300000;
  fire();
  expect(contexts().at(-1)?.phase).toBe("stream_waiting");
  expect(timers).toHaveLength(0);
  const next = new AbortController();
  const add = () =>
    observe(
      { async *[Symbol.asyncIterator]() {} },
      "conv-next",
      "next",
      next.signal,
      {},
      clock,
    );
  for (let n = 0; n < 129; n += 1) add();
  expect(timers).toHaveLength(128);
  old.abort();
  for (const cleanup of cleanups) await cleanup();
  expect(returned).toBe(128);
  add();
  expect(timers).toHaveLength(128); // Late old cleanup must not free new slots.
  now = 420000;
  timers[0]?.();
  expect(contexts().some((r) => r.conversation_id === "conv-next")).toBe(true);
  expect(JSON.stringify(contexts())).not.toContain("secret body");
  next.abort();
});

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of stream) {
  }
}

test("short originals are silent, recovered success is aggregated, and opt-out installs nothing", async () => {
  const backend = {};
  const create = () => ({
    async *[Symbol.asyncIterator]() {
      yield { message_type: "stop_reason", stop_reason: "end_turn" };
    },
  });
  await drain(observe(create(), "conv", "first", undefined, backend));
  expect(contexts()).toHaveLength(0);
  markBusyRequest(backend, "conv", "second");
  await drain(observe(create(), "conv", "second", undefined, backend));
  expect(contexts()).toHaveLength(1);
  expect(contexts()[0]).toMatchObject({
    phase: "stream_eof",
    stop_reason: "end_turn",
  });
  process.env.DO_NOT_TRACK = "1";
  const stream = create();
  const original = stream[Symbol.asyncIterator];
  observe(stream, "conv", "third", undefined, backend, {
    schedule: () => {
      throw new Error("must not schedule");
    },
  });
  expect(stream[Symbol.asyncIterator]).toBe(original);
});

test("errors and abort preserve the upstream contract", async () => {
  const error = new Error("secret error");
  const stream = {
    async *[Symbol.asyncIterator]() {
      yield await Promise.reject(error);
    },
  };
  await expect(
    observe(stream, "conv", "error")[Symbol.asyncIterator]().next(),
  ).rejects.toBe(error);
  expect(contexts().at(-1)?.phase).toBe("stream_failed");
  const controller = new AbortController();
  observe(
    { async *[Symbol.asyncIterator]() {} },
    "conv",
    "abort",
    controller.signal,
  );
  controller.abort();
  expect(contexts().at(-1)?.phase).toBe("stream_cancelled");
  expect(JSON.stringify(contexts())).not.toContain("secret");
});
