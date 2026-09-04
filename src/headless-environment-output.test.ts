import { describe, expect, test } from "bun:test";
import { ApiRequestError } from "@/backend/api/request";
import { buildEnvironmentFailureOutput } from "./headless-environment-output";

describe("headless environment failure output", () => {
  test("emits a safe typed stream-json result for sandbox startup failures", () => {
    const output = buildEnvironmentFailureOutput({
      error: new ApiRequestError(
        'API error (500): {"errorCode":"SANDBOX_CREATION_FAILED","message":"secret detail"}',
        500,
        '{"errorCode":"SANDBOX_CREATION_FAILED","message":"secret detail"}',
      ),
      stage: "sandbox_start",
      agentId: "agent-1",
      conversationId: "conv-1",
      sessionId: "session-1",
      durationMs: 12.4,
      durationApiMs: 4.6,
    });

    expect(output.stream).toEqual(
      expect.objectContaining({
        type: "result",
        subtype: "error",
        result: "The Cloud sandbox could not be started.",
        stop_reason: "error",
        failure: {
          stage: "sandbox_start",
          code: "SANDBOX_CREATION_FAILED",
          message: "The Cloud sandbox could not be started.",
          http_status: 500,
          retryable: true,
          client_message_ids: [],
        },
      }),
    );
    expect(JSON.stringify(output)).not.toContain("secret detail");
  });
});
