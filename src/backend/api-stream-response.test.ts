import { describe, expect, test } from "bun:test";
import Letta from "@letta-ai/letta-client";
import { APIConnectionError } from "@letta-ai/letta-client/core/error";
import { getPreStreamErrorAction } from "@/agent/turn-recovery-policy";
import { APIBackend } from "./backend";

const request = {
  messages: [
    { role: "user" as const, content: "Continue.", otid: "request-1" },
  ],
  streaming: true,
  background: true,
};

describe("API streaming response validation", () => {
  test.each(["text/html", "application/json", ""])(
    "rejects HTTP 200 %s before treating it as an accepted stream",
    async (contentType) => {
      let signal: AbortSignal | null | undefined;
      const client = new Letta({
        apiKey: "test-key",
        baseURL: "https://example.test",
        fetch: async (_url, init) => {
          signal = init?.signal;
          return new Response("<html>upstream unavailable</html>", {
            status: 200,
            headers: { "content-type": contentType },
          });
        },
      });
      const backend = new APIBackend({ getClient: async () => client });
      let failure: unknown;
      try {
        await backend.createConversationMessageStream("conv-1", request);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(APIConnectionError);
      expect(signal?.aborted).toBe(true);
      expect(
        getPreStreamErrorAction(String(failure), 0, 3, {
          transientRetries: 0,
          maxTransientRetries: 3,
        }),
      ).toBe("retry_transient");
    },
  );

  test("preserves valid SSE and request options", async () => {
    const client = new Letta({
      apiKey: "test-key",
      baseURL: "https://example.test",
      fetch: async (_url, init) => {
        expect(JSON.parse(String(init?.body))).toEqual(request);
        expect(new Headers(init?.headers).get("X-Letta-Acting-User-Id")).toBe(
          "user-1",
        );
        return new Response(
          'data: {"message_type":"stop_reason","stop_reason":"end_turn","run_id":"run-1"}\n\ndata: [DONE]\n\n',
          { headers: { "content-type": "text/event-stream; charset=utf-8" } },
        );
      },
    });
    const backend = new APIBackend({ getClient: async () => client });
    const stream = await backend.createConversationMessageStream(
      "conv-1",
      request,
      { maxRetries: 0, headers: { "X-Letta-Acting-User-Id": "user-1" } },
    );
    const chunks: unknown[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    expect(chunks).toEqual([
      { message_type: "stop_reason", stop_reason: "end_turn", run_id: "run-1" },
    ]);
  });

  test("does not turn an accepted SSE disconnect into a new message send", async () => {
    let sends = 0;
    const client = new Letta({
      apiKey: "test-key",
      baseURL: "https://example.test",
      fetch: async () => {
        sends++;
        return new Response(
          new ReadableStream({
            pull(controller) {
              controller.error(new Error("connection terminated"));
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const backend = new APIBackend({ getClient: async () => client });
    const stream = await backend.createConversationMessageStream(
      "conv-1",
      request,
    );
    await expect(stream[Symbol.asyncIterator]().next()).rejects.toThrow(
      "connection terminated",
    );
    expect(sends).toBe(1);
  });
});
