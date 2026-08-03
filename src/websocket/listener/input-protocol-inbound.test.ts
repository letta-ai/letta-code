import { describe, expect, test } from "bun:test";
import {
  getInvalidInputReason,
  isInputCommand,
} from "./input-protocol-inbound";

describe("runtime input protocol", () => {
  test("accepts a string correlation id", () => {
    expect(
      isInputCommand({
        type: "input",
        request_id: "req-1",
        runtime: { agent_id: "agent-1", conversation_id: "conv-1" },
        payload: {
          kind: "create_message",
          messages: [
            {
              role: "user",
              content: "hello",
              client_message_id: "cm-1",
            },
          ],
        },
      }),
    ).toBe(true);
  });

  test("rejects a non-string correlation id with a specific reason", () => {
    const input = {
      type: "input",
      request_id: 42,
      runtime: { agent_id: "agent-1", conversation_id: "conv-1" },
      payload: {
        kind: "create_message",
        messages: [],
      },
    };

    expect(isInputCommand(input)).toBe(false);
    expect(getInvalidInputReason(input)).toEqual({
      runtime: input.runtime,
      reason: "Protocol violation: input.request_id must be a string",
    });
  });
});
