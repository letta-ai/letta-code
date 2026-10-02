import { afterEach, describe, expect, test } from "bun:test";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import { createBuffers } from "@/cli/helpers/accumulator";
import { drainStream } from "@/cli/helpers/stream";
import { LOCAL_IN_PROCESS_STREAM } from "@/utils/stream-transport";

const originalStallMs = process.env.LETTA_STREAM_STALL_RECONCILE_MS;
const originalTerminalMs = process.env.LETTA_STREAM_TERMINAL_EOF_GRACE_MS;

afterEach(() => {
  if (originalStallMs === undefined) {
    delete process.env.LETTA_STREAM_STALL_RECONCILE_MS;
  } else {
    process.env.LETTA_STREAM_STALL_RECONCILE_MS = originalStallMs;
  }
  if (originalTerminalMs === undefined) {
    delete process.env.LETTA_STREAM_TERMINAL_EOF_GRACE_MS;
  } else {
    process.env.LETTA_STREAM_TERMINAL_EOF_GRACE_MS = originalTerminalMs;
  }
});

function localStream(
  iterator: (
    controller: AbortController,
  ) => AsyncGenerator<LettaStreamingResponse>,
) {
  const controller = new AbortController();
  return {
    controller,
    stream: {
      controller,
      [LOCAL_IN_PROCESS_STREAM]: true,
      [Symbol.asyncIterator]: () => iterator(controller),
    } as unknown as Stream<LettaStreamingResponse>,
  };
}

describe("local in-process stream transport recovery", () => {
  test("does not cancel a legitimate slow first token as an HTTP stall", async () => {
    process.env.LETTA_STREAM_STALL_RECONCILE_MS = "10";
    const { stream, controller } = localStream(async function* () {
      await new Promise((resolve) => setTimeout(resolve, 40));
      yield {
        message_type: "stop_reason",
        stop_reason: "end_turn",
      } as LettaStreamingResponse;
    });

    const result = await drainStream(
      stream,
      createBuffers("agent-local"),
      () => {},
    );

    expect(controller.signal.aborted).toBe(false);
    expect(result.stopReason).toBe("end_turn");
    expect(result.stallReconcilerFired).toBe(false);
  });

  test("does not use the HTTP EOF guard to abort a completed local run", async () => {
    process.env.LETTA_STREAM_TERMINAL_EOF_GRACE_MS = "10";
    const { stream, controller } = localStream(async function* () {
      yield {
        message_type: "stop_reason",
        stop_reason: "end_turn",
      } as LettaStreamingResponse;
      await new Promise((resolve) => setTimeout(resolve, 40));
    });

    const result = await drainStream(
      stream,
      createBuffers("agent-local"),
      () => {},
    );

    expect(controller.signal.aborted).toBe(false);
    expect(result.stopReason).toBe("end_turn");
    expect(result.terminalEofGuardFired).toBe(false);
  });
});
