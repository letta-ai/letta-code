import { describe, expect, test } from "bun:test";
import {
  isRetryableLocalProviderError,
  LocalProviderRetryExhaustedError,
  localProviderRetryMessage,
  normalizeLocalProviderError,
} from "@/backend/dev/local-provider-errors";

describe("LocalProviderErrors", () => {
  test("classifies Codex Responses server_error events as retryable LLM errors", () => {
    const error = new Error(
      'Codex error: {"type":"error","error":{"type":"server_error","code":"server_error","message":"An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID 940a060b-50b3-4800-a2bc-6a3937b9553c in your message.","param":null},"sequence_number":6}',
    );

    expect(isRetryableLocalProviderError(error)).toBe(true);
    expect(normalizeLocalProviderError(error)).toMatchObject({
      error_type: "llm_error",
      retryable: true,
      stop_reason: "llm_api_error",
    });
  });

  test("classifies Codex WebSocket 1006 closes as retryable LLM errors", () => {
    const error = new Error("WebSocket closed 1006 Connection ended");

    expect(isRetryableLocalProviderError(error)).toBe(true);
    expect(normalizeLocalProviderError(error)).toMatchObject({
      error_type: "llm_error",
      retryable: true,
      stop_reason: "llm_api_error",
    });
  });

  test("keeps ChatGPT usage limits non-retryable", () => {
    const error = new Error(
      'Codex error: {"type":"error","error":{"type":"usage_limit_reached","code":"usage_limit_reached","message":"The usage limit has been reached","plan_type":"team"}}',
    );

    expect(isRetryableLocalProviderError(error)).toBe(false);
    expect(normalizeLocalProviderError(error)).toMatchObject({
      retryable: false,
      stop_reason: "error",
    });
  });

  test("marks exhausted local provider retry budgets as non-outer-retryable LLM errors", () => {
    const cause = new Error("WebSocket closed 1006 Connection ended");
    const error = new LocalProviderRetryExhaustedError(cause, 4);

    expect(isRetryableLocalProviderError(error)).toBe(false);
    expect(normalizeLocalProviderError(error)).toMatchObject({
      error_type: "llm_error",
      retryable: false,
      stop_reason: "llm_api_error",
    });
    expect(normalizeLocalProviderError(error).detail).toContain(
      "WebSocket closed 1006 Connection ended",
    );
  });

  test("labels Codex backend and WebSocket retries without exposing raw payloads", () => {
    const codexError = (message: string) => ({
      message,
      assistant: {
        api: "openai-codex-responses",
        provider: "openai-codex",
      },
    });

    expect(
      localProviderRetryMessage(
        codexError(
          'Codex error: {"type":"error","error":{"type":"server_error","code":"server_error","message":"You can retry your request."}}',
        ),
      ),
    ).toBe("OpenAI Codex backend server_error");
    expect(
      localProviderRetryMessage(
        codexError("WebSocket closed 1006 Connection ended"),
      ),
    ).toBe("OpenAI Codex WebSocket closed (1006)");
    expect(localProviderRetryMessage(new Error("fetch failed"))).toBe(
      "fetch failed",
    );
  });
});
