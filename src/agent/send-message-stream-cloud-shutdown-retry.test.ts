import { describe, expect, test } from "bun:test";
import { InternalServerError } from "@letta-ai/letta-client/core/error";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import type { Backend } from "@/backend";
import { sendMessageStreamWithBackend } from "./message";

const stream = {
  async *[Symbol.asyncIterator]() {},
} as unknown as Stream<LettaStreamingResponse>;

function shutdownError(
  overrides: Record<string, unknown> = {},
  retryAfter = "0",
): InternalServerError {
  return new InternalServerError(
    503,
    {
      error: "Service temporarily unavailable. Please retry your request.",
      errorCode: "cloud_api_shutting_down",
      admitted: false,
      retryable: true,
      ...overrides,
    },
    undefined,
    new Headers({ "Retry-After": retryAfter }),
  );
}

function sendWithBackend(backend: Backend, signal?: AbortSignal) {
  return sendMessageStreamWithBackend(
    backend,
    "conv-shutdown-retry",
    [{ role: "user", content: "Continue the turn." }],
    {
      streamTokens: true,
      background: true,
      skillSources: [],
      preparedToolContext: {
        contextId: "ctx-shutdown-retry",
        clientTools: [],
        loadedToolNames: [],
      },
    },
    { maxRetries: 0, signal },
  );
}

describe("Cloud API shutdown admission retry", () => {
  test("retries a typed 503 that proves the request was not admitted", async () => {
    let attempts = 0;
    const backend = {
      async createConversationMessageStream() {
        attempts += 1;
        if (attempts === 1) throw shutdownError();
        return stream;
      },
    } as unknown as Backend;

    expect(await sendWithBackend(backend)).toBe(stream);
    expect(attempts).toBe(2);
  });

  test.each([
    ["an admitted request", { admitted: true }],
    ["a response without the retryable flag", { retryable: false }],
    ["a generic 503", { errorCode: "service_unavailable" }],
  ])("does not retry %s", async (_name, overrides) => {
    let attempts = 0;
    const error = shutdownError(overrides);
    const backend = {
      async createConversationMessageStream() {
        attempts += 1;
        throw error;
      },
    } as unknown as Backend;

    await expect(sendWithBackend(backend)).rejects.toBe(error);
    expect(attempts).toBe(1);
  });

  test("stops after three safe retries", async () => {
    let attempts = 0;
    const error = shutdownError();
    const backend = {
      async createConversationMessageStream() {
        attempts += 1;
        throw error;
      },
    } as unknown as Backend;

    await expect(sendWithBackend(backend)).rejects.toBe(error);
    expect(attempts).toBe(4);
  });

  test("cancels while waiting to retry", async () => {
    let attempts = 0;
    const controller = new AbortController();
    const backend = {
      async createConversationMessageStream() {
        attempts += 1;
        queueMicrotask(() => controller.abort());
        throw shutdownError({}, "10");
      },
    } as unknown as Backend;

    await expect(
      sendWithBackend(backend, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(attempts).toBe(1);
  });
});
