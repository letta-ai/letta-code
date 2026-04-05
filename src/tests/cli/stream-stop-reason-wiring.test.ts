import { describe, expect, test } from "bun:test";
import { getEventListeners } from "node:events";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import { createBuffers } from "../../cli/helpers/accumulator";
import { drainStream } from "../../cli/helpers/stream";
import { createStreamAbortRelay } from "../../utils/streamAbortRelay";

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

describe("drainStream stop reason wiring", () => {
  test("catch path preserves streamProcessor.stopReason before falling back to error", () => {
    const streamPath = fileURLToPath(
      new URL("../../cli/helpers/stream.ts", import.meta.url),
    );
    const source = readFileSync(streamPath, "utf-8");

    expect(source).toContain(
      'stopReason = streamProcessor.stopReason || "error"',
    );
  });

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
    expect(getEventListeners(parent.signal, "abort")).toHaveLength(0);
  });
});
