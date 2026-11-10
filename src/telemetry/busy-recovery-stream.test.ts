import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { telemetry } from "@/telemetry";
import { __testResetBusyRecoveryBudget } from "@/telemetry/busy-recovery";
import {
  markBusyRequest,
  traceBusyRecoveryStream,
} from "./busy-recovery-stream";

const diagnostics: Array<Record<string, unknown>> = [];
let spy: ReturnType<typeof spyOn> | undefined;
afterEach(() => {
  spy?.mockRestore();
  diagnostics.length = 0;
});
function capture() {
  spy = spyOn(telemetry, "trackError").mockImplementation(
    (_type, _message, context) => {
      diagnostics.push(JSON.parse(context ?? "{}"));
    },
  );
}

describe("busy recovery stream outcomes", () => {
  test("final checkpoint retires 128 abandoned/hung observers without double release on late cleanup", async () => {
    capture();
    let callbacks: Array<() => void> = [];
    const oldController = new AbortController();
    const oldReaders: AsyncIterator<unknown>[] = [];
    const clock = {
      schedule: (cb: () => void) => {
        callbacks.push(cb);
        return () => {};
      },
    };
    for (let n = 0; n < 128; n += 1) {
      const stream = {
        [Symbol.asyncIterator]: () => ({
          next: () => new Promise<IteratorResult<unknown>>(() => {}),
          return: async () => ({ done: true as const, value: undefined }),
        }),
      };
      const observed = traceBusyRecoveryStream(
        stream,
        "conv-retire",
        `old-${n}`,
        oldController.signal,
        {},
        clock,
      );
      // Half never start iteration, half have genuinely hung reads.
      if (n % 2 === 0) {
        const reader = observed[Symbol.asyncIterator]();
        oldReaders.push(reader);
        void reader.next();
      } else
        oldReaders.push({
          next: async () => ({ done: true as const, value: undefined }),
          return: async () => observed[Symbol.asyncIterator]().return(),
        });
    }
    expect(callbacks).toHaveLength(128);
    const first = callbacks;
    callbacks = [];
    for (const callback of first) callback();
    expect(callbacks).toHaveLength(128);
    const last = callbacks;
    callbacks = [];
    for (const callback of last) callback();
    expect(callbacks).toHaveLength(0);

    const nextController = new AbortController();
    const add = () =>
      traceBusyRecoveryStream(
        { async *[Symbol.asyncIterator]() {} },
        "conv-later",
        "later",
        nextController.signal,
        {},
        clock,
      );
    for (let n = 0; n < 128; n += 1) add();
    expect(callbacks).toHaveLength(128);
    add();
    expect(callbacks).toHaveLength(128);
    oldController.abort();
    for (const reader of oldReaders) await reader.return?.();
    // Late terminal callbacks must not free slots owned by the next generation.
    add();
    expect(callbacks).toHaveLength(128);
    // The telemetry rate budget is tested separately; isolate actual observation here.
    __testResetBusyRecoveryBudget();
    callbacks[0]?.();
    expect(
      diagnostics.some(
        (record) =>
          record.conversation_id === "conv-later" &&
          record.phase === "stream_progress",
      ),
    ).toBe(true);
    nextController.abort();
  });

  test("opt-out installs no observer or timer", () => {
    process.env.DO_NOT_TRACK = "1";
    const stream = { async *[Symbol.asyncIterator]() {} };
    const original = stream[Symbol.asyncIterator];
    let scheduled = 0;
    traceBusyRecoveryStream(
      stream,
      "conv-optout",
      "otid-optout",
      undefined,
      {},
      {
        schedule: () => {
          scheduled += 1;
          return () => {};
        },
      },
    );
    expect(stream[Symbol.asyncIterator]).toBe(original);
    expect(scheduled).toBe(0);
  });

  test("observer and timer allocation is capped at 128 active streams", () => {
    let scheduled = 0;
    const controller = new AbortController();
    for (let n = 0; n < 160; n += 1) {
      const stream = { async *[Symbol.asyncIterator]() {} };
      traceBusyRecoveryStream(
        stream,
        "conv-cap",
        `otid-${n}`,
        controller.signal,
        {},
        {
          schedule: () => {
            scheduled += 1;
            return () => {};
          },
        },
      );
    }
    expect(scheduled).toBe(128);
    controller.abort();
  });

  test("short original successful streams emit nothing", async () => {
    capture();
    const stream = {
      async *[Symbol.asyncIterator]() {
        yield { message_type: "stop_reason", stop_reason: "end_turn" };
      },
    };
    for await (const _ of traceBusyRecoveryStream(
      stream,
      "conv-short",
      "otid-short",
      undefined,
      {},
    )) {
    }
    expect(diagnostics).toHaveLength(0);
  });

  test.each([false, true])(
    "hung original/recovered stream emits two bounded last-state snapshots (recovered=%s)",
    async (recovered) => {
      capture();
      let now = 0;
      let callback: (() => void) | undefined;
      let scheduled = 0;
      let cancelled = 0;
      const controller = new AbortController();
      const backend = {};
      if (recovered) markBusyRequest(backend, "conv-hang", "otid-hang");
      let reads = 0;
      const iterator = {
        next: async () => {
          reads += 1;
          if (reads === 1)
            return {
              done: false as const,
              value: {
                message_type: "reasoning_message",
                run_id: "run-original",
                content: "secret text",
              },
            };
          return new Promise<IteratorResult<unknown>>(() => {});
        },
      };
      const stream = { [Symbol.asyncIterator]: () => iterator };
      const observed = traceBusyRecoveryStream(
        stream,
        "conv-hang",
        "otid-hang",
        controller.signal,
        backend,
        {
          now: () => now,
          schedule: (cb, delay) => {
            callback = cb;
            scheduled += 1;
            expect([60000, 240000]).toContain(delay);
            return () => {
              cancelled += 1;
              callback = undefined;
            };
          },
        },
      );
      const reader = observed[Symbol.asyncIterator]();
      await reader.next();
      let resolved = false;
      void reader.next().then(() => {
        resolved = true;
      });
      await Promise.resolve();
      expect(resolved).toBe(false);
      now = 60000;
      callback?.();
      expect(diagnostics[0]).toMatchObject({
        phase: "stream_progress",
        request_run_id: "run-original",
        chunk_count: 1,
        read_pending: true,
        idle_ms: 60000,
        last_chunk_type: "reasoning_message",
      });
      now = 300000;
      callback?.();
      expect(diagnostics.map((d) => d.phase)).toEqual([
        "stream_progress",
        "stream_waiting",
      ]);
      expect(scheduled).toBe(2);
      expect(JSON.stringify(diagnostics)).not.toContain("secret");
      controller.abort();
      // The observer retired at the last checkpoint; late abort is no longer watched.
      expect(diagnostics.at(-1)?.phase).toBe("stream_waiting");
      expect(cancelled).toBe(1);
    },
  );

  test("a recovered stream aggregates stop reason into its terminal summary", async () => {
    capture();
    const backend = {};
    const chunks = [
      {
        message_type: "assistant_message",
        run_id: "run-request",
        content: "secret",
      },
      {
        message_type: "stop_reason",
        run_id: "run-request",
        stop_reason: "end_turn",
      },
    ];
    const stream = {
      async *[Symbol.asyncIterator]() {
        yield* chunks;
      },
    };
    markBusyRequest(backend, "conv-example", "otid-example");
    expect(
      traceBusyRecoveryStream(
        stream,
        "conv-example",
        "otid-example",
        undefined,
        backend,
      ),
    ).toBe(stream);
    expect(diagnostics).toHaveLength(0);
    const output = [];
    for await (const chunk of stream) output.push(chunk);
    expect(output).toEqual(chunks);
    expect(diagnostics.map((d) => d.phase)).toEqual(["stream_eof"]);
    expect(diagnostics.at(-1)).toMatchObject({
      request_run_id: "run-request",
      stop_reason: "end_turn",
    });
    expect(JSON.stringify(diagnostics)).not.toContain("secret");
  });

  test("EOF without stop reason does not claim model completion", async () => {
    capture();
    const stream = { async *[Symbol.asyncIterator]() {} };
    for await (const _chunk of traceBusyRecoveryStream(
      stream,
      "conv-example",
      "otid-example",
    )) {
    }
    expect(diagnostics.at(-1)?.phase).toBe("stream_eof");
    expect(diagnostics.at(-1)?.stop_reason).toBeUndefined();
  });

  test("transport failure preserves the original exception", async () => {
    capture();
    const error = new Error("secret body");
    const stream = {
      async *[Symbol.asyncIterator]() {
        yield await Promise.reject(error);
      },
    };
    const iterator = traceBusyRecoveryStream(
      stream,
      "conv-example",
      "otid-example",
    )[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toBe(error);
    expect(diagnostics.at(-1)?.phase).toBe("stream_failed");
    expect(JSON.stringify(diagnostics)).not.toContain("secret");
  });

  test("consumer close runs the upstream cleanup and reports only once", async () => {
    capture();
    let cleaned = false;
    const stream = {
      async *[Symbol.asyncIterator]() {
        try {
          yield "secret";
          yield "other";
        } finally {
          cleaned = true;
        }
      },
    };
    for await (const _chunk of traceBusyRecoveryStream(
      stream,
      "conv-example",
      "otid-example",
    ))
      break;
    expect(cleaned).toBe(true);
    expect(diagnostics.map((d) => d.phase)).toEqual(["stream_closed"]);
  });

  test("abort is distinct from transport failure", async () => {
    capture();
    const controller = new AbortController();
    const error = new Error("secret abort");
    const stream = {
      async *[Symbol.asyncIterator]() {
        controller.abort();
        yield await Promise.reject(error);
      },
    };
    const iterator = traceBusyRecoveryStream(
      stream,
      "conv-example",
      "otid-example",
      controller.signal,
    )[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toBe(error);
    expect(diagnostics.at(-1)?.phase).toBe("stream_cancelled");
  });
});

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
