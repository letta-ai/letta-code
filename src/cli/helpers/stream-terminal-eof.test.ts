import { afterEach, describe, expect, test } from "bun:test";
import { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import { createBuffers } from "@/cli/helpers/accumulator";
import { drainStream } from "@/cli/helpers/stream";

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
  test("settles a completed SDK stream even when abort does not close the body", async () => {
    process.env.LETTA_STREAM_TERMINAL_EOF_GRACE_MS = "30";
    const body = new TransformStream<Uint8Array, Uint8Array>();
    const writer = body.writable.getWriter();
    const controller = new AbortController();
    const stream = Stream.fromSSEResponse<LettaStreamingResponse>(
      new Response(body.readable),
      controller,
    );
    const buffers = createBuffers("agent-test");
    const drain = drainStream(stream, buffers, () => {});
    try {
      await writer.write(
        new TextEncoder().encode(
          [
            'data: {"message_type":"stop_reason","stop_reason":"end_turn"}',
            'data: {"message_type":"usage_statistics","total_tokens":12}',
            "data: [DONE]",
            "",
          ].join("\n\n"),
        ),
      );
      const result = await drain;
      expect(controller.signal.aborted).toBe(true);
      expect(result.stopReason).toBe("end_turn");
      expect(buffers.usage.totalTokens).toBe(12);
    } finally {
      await writer.close();
    }
  });

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

    expect(controller.signal.aborted).toBe(true);
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
    expect(result.terminalEofGuardFired).toBe(true);
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
      },
    } as unknown as Stream<LettaStreamingResponse>;

    const buffers = createBuffers("agent-test");
    const result = await drainStream(stream, buffers, () => {});

    expect(controller.signal.aborted).toBe(false);
    expect(result.stopReason).toBe("end_turn");
    expect(result.terminalEofGuardFired).toBe(false);
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
