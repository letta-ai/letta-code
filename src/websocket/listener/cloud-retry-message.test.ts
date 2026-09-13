import { describe, expect, test } from "bun:test";
import {
  normalizeCloudRetryWireMessage,
  parseCloudRetryMessage,
} from "./cloud-retry-message";

describe("parseCloudRetryMessage", () => {
  test("maps the server retry contract", () => {
    expect(
      parseCloudRetryMessage({
        message_type: "retry_message",
        message: "ChatGPT connection failed; trying another transport...",
        retry_kind: "transport_fallback",
        attempt: 1,
        max_attempts: 2,
        delay_ms: 0,
        provider: "chatgpt_oauth",
        from_transport: "ws_proxy",
        to_transport: "direct_ws",
        error_code: null,
        run_id: "run-1",
        step_id: "step-1",
      }),
    ).toEqual({
      message: "ChatGPT connection failed; trying another transport...",
      retryKind: "transport_fallback",
      attempt: 1,
      maxAttempts: 2,
      delayMs: 0,
      provider: "chatgpt_oauth",
      fromTransport: "ws_proxy",
      toTransport: "direct_ws",
      errorCode: null,
      runId: "run-1",
      stepId: "step-1",
    });
  });

  test("normalizes Cloud retry metadata into the listener protocol", () => {
    expect(
      normalizeCloudRetryWireMessage({
        message_type: "retry_message",
        message: "ChatGPT is overloaded; retrying...",
        retry_kind: "provider_retry",
        attempt: 1,
        max_attempts: 2,
        delay_ms: 1000,
        provider: "chatgpt_oauth",
        from_transport: "sse",
        to_transport: "sse",
        error_code: "server_is_overloaded",
        run_id: "run-1",
        step_id: "step-1",
      }),
    ).toMatchObject({
      message_type: "retry",
      message: "ChatGPT is overloaded; retrying...",
      reason: "llm_api_error",
      attempt: 1,
      max_attempts: 2,
      delay_ms: 1000,
      retry_kind: "provider_retry",
      provider: "chatgpt_oauth",
      from_transport: "sse",
      to_transport: "sse",
      error_code: "server_is_overloaded",
      run_id: "run-1",
      step_id: "step-1",
    });
  });

  test("rejects malformed retry messages", () => {
    expect(parseCloudRetryMessage({ message_type: "assistant_message" })).toBe(
      null,
    );
    expect(
      parseCloudRetryMessage({
        message_type: "retry_message",
        message: "Retrying",
        retry_kind: "provider_retry",
        attempt: 2,
        max_attempts: 1,
        delay_ms: 1000,
        provider: "chatgpt_oauth",
      }),
    ).toBe(null);
  });
});
