import { describe, expect, test } from "bun:test";
import { APIError } from "@letta-ai/letta-client/core/error";
import { ApiRequestError } from "@/backend/api/request";
import {
  createEnvironmentTerminalFailure,
  createTerminalFailure,
  TerminalFailureError,
} from "./terminal-failure";

describe("terminal failure normalization", () => {
  test("classifies a credit rejection without exposing the raw response", () => {
    const error = new APIError(
      402,
      {
        error: "raw provider detail",
        reasons: ["letta-tier-usage-exceeded", "not-enough-credits"],
      },
      undefined,
      new Headers(),
    );

    expect(
      createTerminalFailure({
        stage: "agent_turn",
        message: "Your account does not have credits for this model.",
        error,
        clientMessageIds: ["cm-1"],
      }),
    ).toEqual({
      stage: "agent_turn",
      code: "not-enough-credits",
      message: "Your account does not have credits for this model.",
      http_status: 402,
      retryable: false,
      client_message_ids: ["cm-1"],
    });
  });

  test("classifies sandbox startup failures with bounded safe copy", () => {
    const error = new ApiRequestError(
      'API error (500): {"errorCode":"SANDBOX_CREATION_FAILED","message":"secret upstream detail"}',
      500,
      '{"errorCode":"SANDBOX_CREATION_FAILED","message":"secret upstream detail"}',
    );

    expect(createEnvironmentTerminalFailure(error, "sandbox_start")).toEqual({
      stage: "sandbox_start",
      code: "SANDBOX_CREATION_FAILED",
      message: "The Cloud sandbox could not be started.",
      http_status: 500,
      retryable: true,
      client_message_ids: [],
    });
  });

  test("preserves an already normalized remote failure", () => {
    const failure = createTerminalFailure({
      stage: "agent_turn",
      message: "Safe failure",
    });
    expect(
      createEnvironmentTerminalFailure(
        new TerminalFailureError(failure),
        "environment_turn",
      ),
    ).toBe(failure);
  });
});
