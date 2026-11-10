import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { telemetry } from "@/telemetry";
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
  test("normal sends are untouched; a retried OTID records stop and EOF separately", async () => {
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
    const output = [];
    for await (const chunk of stream) output.push(chunk);
    expect(output).toEqual(chunks);
    expect(diagnostics.map((d) => d.phase)).toEqual([
      "stream_attached",
      "stream_stop_received",
      "stream_eof",
    ]);
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
    expect(diagnostics.map((d) => d.phase)).toEqual([
      "stream_attached",
      "stream_closed",
    ]);
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
