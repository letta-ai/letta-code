import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import { createBuffers } from "../../cli/helpers/accumulator";
import { drainStream } from "../../cli/helpers/stream";

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
});
