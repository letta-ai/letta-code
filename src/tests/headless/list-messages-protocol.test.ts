/**
 * Tests for list_messages protocol — types, routing semantics, and
 * error-response construction.
 *
 * Organised in three suites:
 *
 * 1. Type / wire-shape tests — pure TypeScript structural checks.
 * 2. Routing semantics — tests against resolveListMessagesRoute() covering
 *    all four meaningful input combinations.
 * 3. Error propagation — verify error control_response envelope shape and
 *    message extraction.
 *
 * No live Letta API calls are made here; those are in the manual smoke suite.
 */
import { describe, expect, test } from "bun:test";
import { resolveListMessagesRoute } from "../../agent/listMessagesRouting";
import type {
  ControlRequest,
  ControlResponse,
  ListMessagesControlRequest,
  ListMessagesResponsePayload,
} from "../../types/protocol";

// ─────────────────────────────────────────────────────────────────────────────
// 1. Wire-shape / type tests
// ─────────────────────────────────────────────────────────────────────────────

describe("list_messages protocol — wire shapes", () => {
  test("ListMessagesControlRequest accepts all optional fields", () => {
    const req: ListMessagesControlRequest = {
      subtype: "list_messages",
      conversation_id: "conv-123",
      before: "msg-abc",
      order: "desc",
      limit: 50,
    };
    expect(req.subtype).toBe("list_messages");
    expect(req.conversation_id).toBe("conv-123");
    expect(req.limit).toBe(50);
  });

  test("ListMessagesControlRequest works with only agent_id (empty request body)", () => {
    const req: ListMessagesControlRequest = {
      subtype: "list_messages",
      agent_id: "agent-xyz",
      limit: 20,
    };
    expect(req.agent_id).toBe("agent-xyz");
    expect(req.conversation_id).toBeUndefined();
  });

  test("minimal ListMessagesControlRequest (no fields) is valid", () => {
    const req: ListMessagesControlRequest = { subtype: "list_messages" };
    expect(req.subtype).toBe("list_messages");
    expect(req.conversation_id).toBeUndefined();
    expect(req.agent_id).toBeUndefined();
  });

  test("ListMessagesControlRequest assembles into ControlRequest envelope", () => {
    const body: ListMessagesControlRequest = { subtype: "list_messages" };
    const req: ControlRequest = {
      type: "control_request",
      request_id: "list_1739999999999",
      request: body,
    };
    expect(req.type).toBe("control_request");
    expect(req.request_id).toBe("list_1739999999999");
  });

  test("ListMessagesResponsePayload success shape", () => {
    const payload: ListMessagesResponsePayload = {
      messages: [{ id: "msg-1", message_type: "user_message" }],
      next_before: "msg-1",
      has_more: false,
    };
    expect(payload.messages).toHaveLength(1);
    expect(payload.has_more).toBe(false);
    expect(payload.next_before).toBe("msg-1");
  });

  test("ListMessagesResponsePayload empty page", () => {
    const payload: ListMessagesResponsePayload = {
      messages: [],
      next_before: null,
      has_more: false,
    };
    expect(payload.messages).toHaveLength(0);
    expect(payload.next_before).toBeNull();
  });

  test("success control_response wraps list payload correctly", () => {
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
    expect(resp.type).toBe("control_response");
    expect(resp.response.subtype).toBe("success");
    expect(resp.response.request_id).toBe("list_1739999999999");
  });

  test("error control_response carries message string", () => {
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
      expect(resp.response.error).toBe("conversation not found");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Routing semantics (resolveListMessagesRoute)
// ─────────────────────────────────────────────────────────────────────────────

describe("list_messages routing — resolveListMessagesRoute", () => {
  const SESSION_AGENT = "agent-session-default";
  const SESSION_CONV = "conv-session-abc";

  /**
   * Case A: explicit conversation_id in request.
   * Must use conversations.messages.list with the explicit id,
   * regardless of what the session's conversation is.
   */
  test("A — explicit conversation_id → conversations API with that id", () => {
    const route = resolveListMessagesRoute(
      { conversation_id: "conv-explicit-xyz" },
      "default", // session is on default — must be ignored
      SESSION_AGENT,
    );
    expect(route.kind).toBe("conversations");
    if (route.kind === "conversations") {
      expect(route.conversationId).toBe("conv-explicit-xyz");
    }
  });

  test("A — explicit conversation_id overrides non-default session conv", () => {
    const route = resolveListMessagesRoute(
      { conversation_id: "conv-override" },
      "conv-session-other", // different from explicit — must be ignored
      SESSION_AGENT,
    );
    expect(route.kind).toBe("conversations");
    if (route.kind === "conversations") {
      expect(route.conversationId).toBe("conv-override");
    }
  });

  /**
   * Case B: no conversation_id in request, session is on a named conversation.
   * Must use conversations.messages.list with the session's conversation id.
   * This is the backfill case for non-default conversations created mid-session.
   */
  test("B — omitted conversation_id + non-default session → conversations API with session convId", () => {
    const route = resolveListMessagesRoute(
      {}, // no conversation_id
      SESSION_CONV, // session has a real conversation
      SESSION_AGENT,
    );
    expect(route.kind).toBe("conversations");
    if (route.kind === "conversations") {
      expect(route.conversationId).toBe(SESSION_CONV);
    }
  });

  test("B — omitted conversation_id + session conv starts with conv- prefix", () => {
    const realConvId = "conv-0123456789abcdef";
    const route = resolveListMessagesRoute({}, realConvId, SESSION_AGENT);
    expect(route.kind).toBe("conversations");
    if (route.kind === "conversations") {
      expect(route.conversationId).toBe(realConvId);
    }
  });

  /**
   * Case C: no conversation_id in request, session is on the default conversation.
   * Must use agents.messages.list (implicit default conv via agent route).
   */
  test("C — omitted conversation_id + session default → agents API with session agentId", () => {
    const route = resolveListMessagesRoute(
      {}, // no conversation_id
      "default", // session is on default conversation
      SESSION_AGENT,
    );
    expect(route.kind).toBe("agents");
    if (route.kind === "agents") {
      expect(route.agentId).toBe(SESSION_AGENT);
    }
  });

  test("C — explicit agent_id in request + session default → uses request agentId", () => {
    const route = resolveListMessagesRoute(
      { agent_id: "agent-override-id" },
      "default",
      SESSION_AGENT,
    );
    expect(route.kind).toBe("agents");
    if (route.kind === "agents") {
      // Request's agent_id takes priority over session agent when on default conv
      expect(route.agentId).toBe("agent-override-id");
    }
  });

  test("C — no conversation_id, no agent_id, session default → falls back to session agentId", () => {
    const route = resolveListMessagesRoute(
      {},
      "default",
      "agent-session-fallback",
    );
    expect(route.kind).toBe("agents");
    if (route.kind === "agents") {
      expect(route.agentId).toBe("agent-session-fallback");
    }
  });

  /**
   * Invariant: "default" is the only string that triggers the agents path.
   * Any other string (even empty, or a UUID-like string) uses conversations.
   */
  test("conversations path for any non-default conversation string", () => {
    const convIds = [
      "conv-00000000-0000-0000-0000-000000000000",
      "some-arbitrary-id",
      " ", // whitespace — unusual but should still use conversations path
    ];
    for (const id of convIds) {
      const route = resolveListMessagesRoute({}, id, SESSION_AGENT);
      expect(route.kind).toBe("conversations");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Error propagation — envelope construction
// ─────────────────────────────────────────────────────────────────────────────

describe("list_messages — error control_response construction", () => {
  /** Simulates what the headless handler does in the catch block. */
  function buildErrorResponse(
    err: unknown,
    requestId: string,
    sessionId: string,
  ): ControlResponse {
    return {
      type: "control_response",
      session_id: sessionId,
      uuid: "test-uuid",
      response: {
        subtype: "error",
        request_id: requestId,
        error: err instanceof Error ? err.message : "list_messages failed",
      },
    };
  }

  test("Error instance message is extracted", () => {
    const resp = buildErrorResponse(
      new Error("conversation not found"),
      "req-1",
      "sess-1",
    );
    expect(resp.response.subtype).toBe("error");
    if (resp.response.subtype === "error") {
      expect(resp.response.error).toBe("conversation not found");
      expect(resp.response.request_id).toBe("req-1");
    }
  });

  test("Non-Error throw falls back to generic message", () => {
    const resp = buildErrorResponse("something went wrong", "req-2", "sess-1");
    if (resp.response.subtype === "error") {
      expect(resp.response.error).toBe("list_messages failed");
    }
  });

  test("APIError (subclass of Error) uses message", () => {
    class APIError extends Error {}
    const resp = buildErrorResponse(
      new APIError("403 Forbidden"),
      "req-3",
      "sess-1",
    );
    if (resp.response.subtype === "error") {
      expect(resp.response.error).toBe("403 Forbidden");
    }
  });

  test("null throw falls back to generic message", () => {
    const resp = buildErrorResponse(null, "req-4", "sess-1");
    if (resp.response.subtype === "error") {
      expect(resp.response.error).toBe("list_messages failed");
    }
  });

  test("request_id is echoed from the original request", () => {
    const requestId = `list-${Date.now()}`;
    const resp = buildErrorResponse(new Error("timeout"), requestId, "sess-1");
    if (resp.response.subtype === "error") {
      expect(resp.response.request_id).toBe(requestId);
    }
  });
});
