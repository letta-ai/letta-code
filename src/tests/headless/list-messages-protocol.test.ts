/**
 * Tests for list_messages control protocol types and wire-format correctness.
 *
 * These are pure shape/type tests — they do not spin up a real Letta server.
 * Integration tests (real client.conversations.messages.list calls) require
 * a live API key and are in the manual smoke-test suite.
 */
import { describe, expect, test } from "bun:test";
import type {
  ControlRequest,
  ControlResponse,
  ListMessagesControlRequest,
  ListMessagesResponsePayload,
} from "../../types/protocol";

describe("list_messages protocol types", () => {
  test("ListMessagesControlRequest accepts all valid fields", () => {
    const req: ListMessagesControlRequest = {
      subtype: "list_messages",
      conversation_id: "conv-123",
      before: "msg-abc",
      order: "desc",
      limit: 50,
    };
    expect(req.subtype).toBe("list_messages");
    expect(req.conversation_id).toBe("conv-123");
  });

  test("ListMessagesControlRequest works with only agent_id (default conv)", () => {
    const req: ListMessagesControlRequest = {
      subtype: "list_messages",
      agent_id: "agent-xyz",
      limit: 20,
    };
    expect(req.agent_id).toBe("agent-xyz");
    expect(req.conversation_id).toBeUndefined();
  });

  test("ListMessagesControlRequest is a valid SdkToCliControlRequest (structural check)", () => {
    const body: ListMessagesControlRequest = {
      subtype: "list_messages",
    };
    const req: ControlRequest = {
      type: "control_request",
      request_id: "list_1739999999999",
      request: body,
    };
    expect(req.request_id).toBe("list_1739999999999");
  });

  test("ListMessagesResponsePayload wire shape is correct", () => {
    const payload: ListMessagesResponsePayload = {
      messages: [{ id: "msg-1", message_type: "user_message" }],
      next_before: "msg-1",
      has_more: false,
    };
    expect(payload.messages).toHaveLength(1);
    expect(payload.has_more).toBe(false);
  });

  test("control_response success envelope wraps list payload", () => {
    const payload: ListMessagesResponsePayload = {
      messages: [],
      next_before: null,
      has_more: false,
    };
    const resp: ControlResponse = {
      type: "control_response",
      session_id: "session-1",
      uuid: "uuid-1",
      response: {
        subtype: "success",
        request_id: "list_1739999999999",
        response: payload as unknown as Record<string, unknown>,
      },
    };
    expect(resp.response.subtype).toBe("success");
  });

  test("control_response error envelope is well-formed", () => {
    const resp: ControlResponse = {
      type: "control_response",
      session_id: "session-1",
      uuid: "uuid-2",
      response: {
        subtype: "error",
        request_id: "list_1739999999999",
        error: "conversation not found",
      },
    };
    expect(resp.response.subtype).toBe("error");
    if (resp.response.subtype === "error") {
      expect(resp.response.error).toContain("conversation not found");
    }
  });
});
