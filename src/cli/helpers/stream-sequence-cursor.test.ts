import { describe, expect, test } from "bun:test";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import { createBuffers } from "@/cli/helpers/accumulator";
import {
  advanceStreamSequenceCursor,
  drainStream,
  type StreamSequenceCursor,
} from "@/cli/helpers/stream";

function stream(
  chunks: LettaStreamingResponse[],
): Stream<LettaStreamingResponse> {
  return {
    controller: new AbortController(),
    async *[Symbol.asyncIterator]() {
      yield* chunks;
    },
  } as unknown as Stream<LettaStreamingResponse>;
}

function chunk(
  runId: string,
  seqId: number,
  value: Record<string, unknown>,
): LettaStreamingResponse {
  return {
    ...value,
    run_id: runId,
    seq_id: seqId,
  } as unknown as LettaStreamingResponse;
}

async function drain(
  chunks: LettaStreamingResponse[],
  cursor: StreamSequenceCursor | null = null,
) {
  return drainStream(
    stream(chunks),
    createBuffers("agent-test"),
    () => {},
    undefined,
    undefined,
    () => ({ shouldAccumulate: false }),
    undefined,
    cursor,
  );
}

const approval = (runId: string, seqId: number) =>
  chunk(runId, seqId, {
    message_type: "approval_request_message",
    id: "message-approval",
    tool_call: {
      tool_call_id: "call-approval",
      name: "exec_command",
      arguments: '{"cmd":"git status"}',
    },
  });

describe("stream sequence cursor", () => {
  test("does not filter a fresh run with reused sequence IDs", async () => {
    const first = await drain([
      chunk("run-a", 1, { message_type: "ping" }),
      chunk("run-a", 3, {
        message_type: "stop_reason",
        stop_reason: "llm_api_error",
      }),
    ]);
    if (!first.lastRunId || first.lastSeqId == null) {
      throw new Error("first run did not produce a sequence cursor");
    }
    const cursor = advanceStreamSequenceCursor(
      null,
      first.lastRunId,
      first.lastSeqId,
    );

    const second = await drain(
      [
        chunk("run-b", 1, { message_type: "user_message" }),
        chunk("run-b", 2, { message_type: "ping" }),
        approval("run-b", 3),
        chunk("run-b", 4, { message_type: "event_message" }),
        chunk("run-b", 5, { message_type: "summary_message" }),
        chunk("run-b", 6, {
          message_type: "stop_reason",
          stop_reason: "requires_approval",
        }),
      ],
      cursor,
    );

    expect(second.stopReason).toBe("requires_approval");
    expect(second.approvals).toEqual([
      {
        toolCallId: "call-approval",
        toolName: "exec_command",
        toolArgs: '{"cmd":"git status"}',
        messageId: "message-approval",
      },
    ]);
  });

  test("still filters replayed sequence IDs from the same run", async () => {
    const result = await drain(
      [
        approval("run-a", 3),
        chunk("run-a", 4, {
          message_type: "stop_reason",
          stop_reason: "end_turn",
        }),
      ],
      { runId: "run-a", seqId: 3 },
    );

    expect(result.stopReason).toBe("end_turn");
    expect(result.approvals).toEqual([]);
  });
});
