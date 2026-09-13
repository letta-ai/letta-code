import { afterEach, describe, expect, test } from "bun:test";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import { createBuffers } from "@/cli/helpers/accumulator";
import { drainStream } from "@/cli/helpers/stream";

/**
 * Regression tests for the terminal-EOF guard (LET-10707).
 *
 * Production failure mode: the server finishes the run and emits the full
 * terminal SSE sequence (stop_reason, usage_statistics, [DONE]), but the HTTP
 * response body never observably ends at the client. The generated
 * letta-client consumes [DONE] internally and only finishes its iterator on
 * HTTP body EOF, so drainStream's `for await` waits forever and the turn
 * wedges before tool execution (multi-hour stalls in PROCESSING_API_RESPONSE
 * with zero executing tools).
 *
 * The fake streams below model the SDK contract: after yielding the parsed
 * JSON events, the iterator stays pending until the stream controller is
 * aborted, then returns cleanly (the SDK swallows AbortError and returns).
 */

function makeHangingTerminalStream(chunks: LettaStreamingResponse[]): {
  stream: Stream<LettaStreamingResponse>;
  controller: AbortController;
} {
  const controller = new AbortController();
  const stream = {
    controller,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        yield chunk;
      }
      // HTTP body never reports EOF. The real SDK iterator only finishes when
      // the body ends or the controller aborts (clean return, no throw).
      await new Promise<void>((resolve) => {
        if (controller.signal.aborted) {
          resolve();
          return;
        }
        controller.signal.addEventListener("abort", () => resolve(), {
          once: true,
        });
      });
    },
  } as unknown as Stream<LettaStreamingResponse>;
  return { stream, controller };
}

const originalGrace = process.env.LETTA_STREAM_TERMINAL_EOF_GRACE_MS;

afterEach(() => {
  if (originalGrace === undefined) {
    delete process.env.LETTA_STREAM_TERMINAL_EOF_GRACE_MS;
  } else {
    process.env.LETTA_STREAM_TERMINAL_EOF_GRACE_MS = originalGrace;
  }
});

describe("drainStream terminal-EOF guard", () => {
  test("returns requires_approval when body never ends after terminal sequence", async () => {
    process.env.LETTA_STREAM_TERMINAL_EOF_GRACE_MS = "50";

    const { stream, controller } = makeHangingTerminalStream([
      {
        message_type: "approval_request_message",
        id: "message-approval-1",
        tool_call: {
          tool_call_id: "tc-updateplan",
          name: "UpdatePlan",
          arguments: '{"plan":"[]"}',
        },
      } as LettaStreamingResponse,
      {
        message_type: "stop_reason",
        stop_reason: "requires_approval",
      } as LettaStreamingResponse,
      {
        message_type: "usage_statistics",
        prompt_tokens: 100,
        completion_tokens: 10,
        total_tokens: 110,
      } as LettaStreamingResponse,
    ]);

    const buffers = createBuffers("agent-test");
    const result = await drainStream(stream, buffers, () => {});

    // Guard must have aborted the wedged HTTP read...
    expect(controller.signal.aborted).toBe(true);
    // ...and the drain must surface the already-received terminal state so the
    // approval/tool-execution flow proceeds.
    expect(result.stopReason).toBe("requires_approval");
    expect(result.sawStopReasonChunk).toBe(true);
    expect(result.approvals).toEqual([
      {
        toolCallId: "tc-updateplan",
        toolName: "UpdatePlan",
        toolArgs: '{"plan":"[]"}',
        messageId: "message-approval-1",
      },
    ]);
    expect(buffers.usage.totalTokens).toBe(110);
    // The firing is reported so consumers (listener/headless) can surface it.
    expect(result.terminalEofGuardFired).toBe(true);
    // The stall is surfaced as a nonblocking status line in the transcript.
    const statusLines = Array.from(buffers.byId.values()).filter(
      (line) => line.kind === "status",
    );
    expect(statusLines).toHaveLength(1);
    expect(statusLines[0]?.lines[0]).toContain("Stream did not close");
  });

  test("returns end_turn when body never ends after terminal sequence", async () => {
    process.env.LETTA_STREAM_TERMINAL_EOF_GRACE_MS = "50";

    const { stream, controller } = makeHangingTerminalStream([
      {
        message_type: "assistant_message",
        id: "msg-1",
        content: "done",
      } as LettaStreamingResponse,
      {
        message_type: "stop_reason",
        stop_reason: "end_turn",
      } as LettaStreamingResponse,
      {
        message_type: "usage_statistics",
        prompt_tokens: 5,
        completion_tokens: 5,
        total_tokens: 10,
      } as LettaStreamingResponse,
    ]);

    const result = await drainStream(
      stream,
      createBuffers("agent-test"),
      () => {},
    );

    expect(controller.signal.aborted).toBe(true);
    expect(result.stopReason).toBe("end_turn");
    expect(result.sawStopReasonChunk).toBe(true);
  });

  test("does not abort a stream that ends normally after the terminal sequence", async () => {
    process.env.LETTA_STREAM_TERMINAL_EOF_GRACE_MS = "5000";

    const controller = new AbortController();
    const stream = {
      controller,
      async *[Symbol.asyncIterator]() {
        yield {
          message_type: "stop_reason",
          stop_reason: "end_turn",
        } as LettaStreamingResponse;
        yield {
          message_type: "usage_statistics",
          prompt_tokens: 1,
          completion_tokens: 1,
          total_tokens: 2,
        } as LettaStreamingResponse;
        // Body ends normally (EOF) right after the terminal sequence.
      },
    } as unknown as Stream<LettaStreamingResponse>;

    const buffers = createBuffers("agent-test");
    const result = await drainStream(stream, buffers, () => {});

    expect(controller.signal.aborted).toBe(false);
    expect(result.stopReason).toBe("end_turn");
    expect(result.terminalEofGuardFired).toBe(false);
    // No stall, no notice.
    expect(
      Array.from(buffers.byId.values()).some((line) => line.kind === "status"),
    ).toBe(false);
  });

  test("guard does not fire before a stop_reason chunk arrives", async () => {
    process.env.LETTA_STREAM_TERMINAL_EOF_GRACE_MS = "30";

    const controller = new AbortController();
    const stream = {
      controller,
      async *[Symbol.asyncIterator]() {
        yield {
          message_type: "assistant_message",
          id: "msg-slow",
          content: "thinking",
        } as LettaStreamingResponse;
        // Mid-stream pause longer than the grace window: legitimate slow
        // generation, no stop_reason yet — the guard must stay unarmed.
        await new Promise((resolve) => setTimeout(resolve, 90));
        yield {
          message_type: "stop_reason",
          stop_reason: "end_turn",
        } as LettaStreamingResponse;
      },
    } as unknown as Stream<LettaStreamingResponse>;

    const result = await drainStream(
      stream,
      createBuffers("agent-test"),
      () => {},
    );

    expect(controller.signal.aborted).toBe(false);
    expect(result.stopReason).toBe("end_turn");
  });
});
