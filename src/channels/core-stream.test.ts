import { describe, expect, test } from "bun:test";
import {
  collectLettaSseAssistantText,
  formatLettaStreamCoreErrorForChannel,
  LettaStreamCoreError,
  LettaStreamNoAssistantMessageError,
} from "@/channels/core-stream";

function streamFromText(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

describe("core stream helpers", () => {
  test("collects assistant text from Letta SSE frames", async () => {
    const result = await collectLettaSseAssistantText(
      streamFromText(
        [
          'data: {"message_type":"ping"}',
          "",
          'data: {"message_type":"assistant_message","content":[{"type":"text","text":"hello"}]}',
          "",
          'data: {"message_type":"assistant_message","content":"world"}',
          "",
          'data: {"message_type":"stop_reason","stop_reason":"end_turn"}',
          "",
          "data: [DONE]",
          "",
        ].join("\n"),
      ),
    );

    expect(result).toEqual({
      text: "hello world",
      chunkCount: 2,
      stopReason: "end_turn",
    });
  });

  test("throws structured Core stream errors", async () => {
    await expect(
      collectLettaSseAssistantText(
        streamFromText(
          [
            "event: error",
            'data: {"message_type":"error_message","error_type":"llm_authentication","message":"Authentication failed","detail":"bad key","run_id":"run-1"}',
            "",
            "data: [DONE]",
            "",
          ].join("\n"),
        ),
      ),
    ).rejects.toMatchObject({
      name: "LettaStreamCoreError",
      errorType: "llm_authentication",
      message: "Authentication failed",
      detail: "bad key",
      runId: "run-1",
    });
  });

  test("throws when no assistant message is present", async () => {
    await expect(
      collectLettaSseAssistantText(
        streamFromText(
          [
            'data: {"message_type":"ping"}',
            "",
            'data: {"message_type":"stop_reason","stop_reason":"end_turn"}',
            "",
            "data: [DONE]",
            "",
          ].join("\n"),
        ),
      ),
    ).rejects.toBeInstanceOf(LettaStreamNoAssistantMessageError);
  });

  test("formats Core stream errors for channel delivery", () => {
    const error = new LettaStreamCoreError({
      errorType: "llm_authentication",
      message: "Authentication failed with the LLM model provider.",
      detail:
        "UNAUTHENTICATED: Authentication failed with OpenAI: Error code: 401 - invalid key",
      runId: "run-1",
    });

    expect(formatLettaStreamCoreErrorForChannel(error)).toBe(
      "Authentication failed with the LLM model provider.\nUNAUTHENTICATED: Authentication failed with OpenAI: Error code: 401 - invalid key",
    );
    expect(
      formatLettaStreamCoreErrorForChannel(error, { includeDetail: false }),
    ).toBe("Authentication failed with the LLM model provider.");
  });
});
