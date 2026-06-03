import { describe, expect, test } from "bun:test";
import { getEventListeners } from "node:events";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import { createBuffers } from "@/cli/helpers/accumulator";
import { drainStream } from "@/cli/helpers/stream";
import { createStreamAbortRelay } from "@/utils/stream-abort-relay";

function makeStreamWithToolCall(
  toolCallId = "tc-1",
): Stream<LettaStreamingResponse> {
  return {
    controller: new AbortController(),
    async *[Symbol.asyncIterator]() {
      // Seed a running server-side tool call
      yield {
        message_type: "tool_call_message",
        id: "msg-1",
        tool_call: {
          tool_call_id: toolCallId,
          name: "Bash",
          arguments: '{"command":"ls"}',
        },
      } as LettaStreamingResponse;
      // Then die mid-stream
      throw new Error("simulated network drop");
    },
  } as unknown as Stream<LettaStreamingResponse>;
}

describe("drainStream stop reason", () => {
  test("preserves llm_api_error when stream throws after stop_reason chunk", async () => {
    const fakeStream = {
      controller: new AbortController(),
      async *[Symbol.asyncIterator]() {
        yield {
          message_type: "stop_reason",
          stop_reason: "llm_api_error",
        } as LettaStreamingResponse;
        throw new Error("peer closed connection");
      },
    } as unknown as Stream<LettaStreamingResponse>;

    const result = await drainStream(
      fakeStream,
      createBuffers("agent-test"),
      () => {},
    );

    expect(result.stopReason).toBe("llm_api_error");
    expect(result.sawStopReasonChunk).toBe(true);
  });

  test("coerces end_turn with pending approvals into requires_approval", async () => {
    const fakeStream = {
      controller: new AbortController(),
      async *[Symbol.asyncIterator]() {
        yield {
          message_type: "approval_request_message",
          tool_call: {
            tool_call_id: "tc-end-turn",
            name: "ShellCommand",
            arguments: '{"command":"pwd"}',
          },
        } as LettaStreamingResponse;
        yield {
          message_type: "stop_reason",
          stop_reason: "end_turn",
        } as LettaStreamingResponse;
      },
    } as unknown as Stream<LettaStreamingResponse>;

    const result = await drainStream(
      fakeStream,
      createBuffers("agent-test"),
      () => {},
    );

    expect(result.stopReason).toBe("requires_approval");
    expect(result.sawStopReasonChunk).toBe(true);
    expect(result.approvals).toEqual([
      {
        toolCallId: "tc-end-turn",
        toolName: "ShellCommand",
        toolArgs: '{"command":"pwd"}',
      },
    ]);
  });

  test("end_turn removes orphaned tool calls entirely (tool_call_message without approval_request or tool_return)", async () => {
    // Simulate: server sends tool_call_message, then decides to end turn without
    // sending approval_request_message or tool_return_message. This can happen if
    // the model hits token limits or decides to stop mid-tool-call.
    const fakeStream = {
      controller: new AbortController(),
      async *[Symbol.asyncIterator]() {
        yield {
          message_type: "tool_call_message",
          id: "msg-orphan",
          tool_call: {
            tool_call_id: "tc-orphan",
            name: "Bash",
            arguments: '{"command":"ls"',
          },
        } as LettaStreamingResponse;
        // Args incomplete, no approval_request, no tool_return — just end_turn
        yield {
          message_type: "stop_reason",
          stop_reason: "end_turn",
        } as LettaStreamingResponse;
      },
    } as unknown as Stream<LettaStreamingResponse>;

    const buffers = createBuffers("agent-test");
    const result = await drainStream(fakeStream, buffers, () => {});

    expect(result.stopReason).toBe("end_turn");
    expect(result.sawStopReasonChunk).toBe(true);

    // Tool call should be removed entirely, not shown as cancelled
    expect(buffers.byId.has("tc-orphan")).toBe(false);
    expect(buffers.order).not.toContain("tc-orphan");
  });

  test("stream error cancels in-progress tool calls by default (skipCancelToolsOnError=false)", async () => {
    const buffers = createBuffers("agent-test");
    await drainStream(makeStreamWithToolCall("tc-1"), buffers, () => {});

    const toolLine = buffers.byId.get("tc-1");
    expect(toolLine?.kind).toBe("tool_call");
    const tl = toolLine as {
      kind: string;
      phase?: string;
      resultOk?: boolean;
      resultText?: string;
    };
    expect(tl.phase).toBe("finished");
    expect(tl.resultOk).toBe(false);
    expect(tl.resultText).toBe("Stream error");
  });

  test("stream error leaves tool calls in running state when skipCancelToolsOnError=true", async () => {
    const buffers = createBuffers("agent-test");
    await drainStream(
      makeStreamWithToolCall("tc-2"),
      buffers,
      () => {},
      undefined, // abortSignal
      undefined, // onFirstMessage
      undefined, // onChunkProcessed
      undefined, // contextTracker
      undefined, // seenSeqIdThreshold
      false, // isResumeStream
      true, // skipCancelToolsOnError
    );

    const toolLine = buffers.byId.get("tc-2");
    expect(toolLine?.kind).toBe("tool_call");
    const tl2 = toolLine as { kind: string; phase?: string };
    // Tool should NOT have been cancelled — phase stays running/streaming
    expect(tl2.phase).not.toBe("finished");
    // interrupted flag should still be set
    expect(buffers.interrupted).toBe(true);
  });

  test("drainStream cleans up registered relayed abort listeners after completion", async () => {
    const parent = new AbortController();
    const relay = createStreamAbortRelay(parent.signal);
    if (!relay) {
      throw new Error("expected stream abort relay");
    }

    const fakeStream = {
      controller: new AbortController(),
      async *[Symbol.asyncIterator]() {
        yield {
          message_type: "stop_reason",
          stop_reason: "end_turn",
        } as LettaStreamingResponse;
      },
    } as unknown as Stream<LettaStreamingResponse>;

    relay.attach(fakeStream as object);
    expect(getEventListeners(parent.signal, "abort")).toHaveLength(1);

    const result = await drainStream(
      fakeStream,
      createBuffers("agent-test"),
      () => {},
      parent.signal,
    );

    expect(result.stopReason).toBe("end_turn");
    expect(result.sawStopReasonChunk).toBe(true);
    expect(getEventListeners(parent.signal, "abort")).toHaveLength(0);
  });

  test("drainStream tolerates stream controllers without abort()", async () => {
    const parent = new AbortController();
    parent.abort();

    const fakeStream = {
      controller: { signal: { aborted: false } },
      async *[Symbol.asyncIterator]() {
        yield {
          message_type: "stop_reason",
          stop_reason: "end_turn",
        } as LettaStreamingResponse;
      },
    } as unknown as Stream<LettaStreamingResponse>;

    const result = await drainStream(
      fakeStream,
      createBuffers("agent-test"),
      () => {},
      parent.signal,
    );

    expect(result.stopReason).toBe("cancelled");
  });
});
