/**
 * Handler-level tests for bootstrap_session_state using mock Letta clients.
 *
 * Verifies:
 * 1. Correct routing (conversations vs agents path based on session conversationId)
 * 2. Response payload shape (agent_id, conversation_id, model, tools, messages, etc.)
 * 3. Pagination fields (next_before, has_more)
 * 4. Timing fields presence
 * 5. Error path — client throws → error envelope returned
 * 6. Default conversation uses agents.messages.list with conversation_id: "default"
 * 7. Explicit conversation uses conversations.messages.list
 *
 * No network. No CLI subprocess. No process.stdout.
 */
import { describe, expect, mock, test } from "bun:test";
import type {
  BootstrapHandlerClient,
  BootstrapHandlerSessionContext,
} from "../../agent/bootstrapHandler";
import { handleBootstrapSessionState } from "../../agent/bootstrapHandler";

// ─────────────────────────────────────────────────────────────────────────────
// Mock factory
// ─────────────────────────────────────────────────────────────────────────────

function makeClient(
  convMessages: unknown[] = [],
  agentMessages: unknown[] = [],
): {
  client: BootstrapHandlerClient;
  convListSpy: ReturnType<typeof mock>;
  agentListSpy: ReturnType<typeof mock>;
} {
  const convListSpy = mock(async () => ({
    getPaginatedItems: () => convMessages,
  }));
  const agentListSpy = mock(async () => ({
    items: agentMessages,
  }));

  const client: BootstrapHandlerClient = {
    conversations: {
      messages: {
        list: convListSpy as unknown as BootstrapHandlerClient["conversations"]["messages"]["list"],
      },
    },
    agents: {
      messages: {
        list: agentListSpy as unknown as BootstrapHandlerClient["agents"]["messages"]["list"],
      },
    },
  };

  return { client, convListSpy, agentListSpy };
}

const BASE_CTX: BootstrapHandlerSessionContext = {
  agentId: "agent-test-123",
  conversationId: "default",
  model: "anthropic/claude-sonnet-4-5",
  tools: ["Bash", "Read", "Write"],
  memfsEnabled: false,
  sessionId: "sess-test",
};

// ─────────────────────────────────────────────────────────────────────────────
// Routing
// ─────────────────────────────────────────────────────────────────────────────

describe("bootstrap_session_state routing", () => {
  test("default conversation uses agents.messages.list", async () => {
    const { client, agentListSpy, convListSpy } = makeClient(
      [],
      [{ id: "msg-1", type: "user_message" }],
    );

    await handleBootstrapSessionState({
      bootstrapReq: { subtype: "bootstrap_session_state" },
      sessionContext: { ...BASE_CTX, conversationId: "default" },
      requestId: "req-1",
      client,
    });

    expect(agentListSpy).toHaveBeenCalledTimes(1);
    expect(convListSpy).toHaveBeenCalledTimes(0);

    // Verify conversation_id: "default" param is passed
    const callArgs = (agentListSpy.mock.calls[0] as unknown[])[1] as Record<
      string,
      unknown
    >;
    expect(callArgs.conversation_id).toBe("default");
  });

  test("named conversation uses conversations.messages.list", async () => {
    const { client, convListSpy, agentListSpy } = makeClient([
      { id: "msg-1", type: "user_message" },
    ]);

    await handleBootstrapSessionState({
      bootstrapReq: { subtype: "bootstrap_session_state" },
      sessionContext: { ...BASE_CTX, conversationId: "conv-abc-123" },
      requestId: "req-2",
      client,
    });

    expect(convListSpy).toHaveBeenCalledTimes(1);
    expect(agentListSpy).toHaveBeenCalledTimes(0);

    const callArgs = (convListSpy.mock.calls[0] as unknown[])[0];
    expect(callArgs).toBe("conv-abc-123");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Response shape
// ─────────────────────────────────────────────────────────────────────────────

describe("bootstrap_session_state response shape", () => {
  test("success response includes all required fields", async () => {
    const messages = [
      { id: "msg-3", type: "assistant_message" },
      { id: "msg-2", type: "user_message" },
      { id: "msg-1", type: "user_message" },
    ];
    const { client } = makeClient([], messages);

    const resp = await handleBootstrapSessionState({
      bootstrapReq: { subtype: "bootstrap_session_state" },
      sessionContext: BASE_CTX,
      requestId: "req-3",
      client,
    });

    expect(resp.type).toBe("control_response");
    expect(resp.response.subtype).toBe("success");
    expect(resp.response.request_id).toBe("req-3");
    expect(resp.session_id).toBe("sess-test");
    expect(typeof resp.uuid).toBe("string");

    const payload = (resp.response as { response: Record<string, unknown> })
      .response;
    expect(payload.agent_id).toBe("agent-test-123");
    expect(payload.conversation_id).toBe("default");
    expect(payload.model).toBe("anthropic/claude-sonnet-4-5");
    expect(payload.tools).toEqual(["Bash", "Read", "Write"]);
    expect(payload.memfs_enabled).toBe(false);
    expect(Array.isArray(payload.messages)).toBe(true);
    expect((payload.messages as unknown[]).length).toBe(3);
    expect(typeof payload.has_more).toBe("boolean");
    expect(typeof payload.has_pending_approval).toBe("boolean");
  });

  test("has_pending_approval defaults to false", async () => {
    const { client } = makeClient();
    const resp = await handleBootstrapSessionState({
      bootstrapReq: { subtype: "bootstrap_session_state" },
      sessionContext: BASE_CTX,
      requestId: "req-4",
      client,
    });
    const payload = (resp.response as { response: Record<string, unknown> })
      .response;
    expect(payload.has_pending_approval).toBe(false);
  });

  test("has_pending_approval reflects caller-provided value", async () => {
    const { client } = makeClient();
    const resp = await handleBootstrapSessionState({
      bootstrapReq: { subtype: "bootstrap_session_state" },
      sessionContext: BASE_CTX,
      requestId: "req-5",
      client,
      hasPendingApproval: true,
    });
    const payload = (resp.response as { response: Record<string, unknown> })
      .response;
    expect(payload.has_pending_approval).toBe(true);
  });

  test("timings are present and numeric", async () => {
    const { client } = makeClient();
    const resp = await handleBootstrapSessionState({
      bootstrapReq: { subtype: "bootstrap_session_state" },
      sessionContext: BASE_CTX,
      requestId: "req-6",
      client,
    });
    const payload = (resp.response as { response: Record<string, unknown> })
      .response;
    const timings = payload.timings as Record<string, unknown>;
    expect(typeof timings).toBe("object");
    expect(typeof timings.resolve_ms).toBe("number");
    expect(typeof timings.list_messages_ms).toBe("number");
    expect(typeof timings.total_ms).toBe("number");
    // Sanity: total_ms >= list_messages_ms
    expect(timings.total_ms as number).toBeGreaterThanOrEqual(
      timings.list_messages_ms as number,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pagination
// ─────────────────────────────────────────────────────────────────────────────

describe("bootstrap_session_state pagination", () => {
  test("has_more is false when messages < limit", async () => {
    const messages = Array.from({ length: 5 }, (_, i) => ({
      id: `msg-${i}`,
      type: "user_message",
    }));
    const { client } = makeClient([], messages);

    const resp = await handleBootstrapSessionState({
      bootstrapReq: { subtype: "bootstrap_session_state", limit: 50 },
      sessionContext: BASE_CTX,
      requestId: "req-7",
      client,
    });
    const payload = (resp.response as { response: Record<string, unknown> })
      .response;
    expect(payload.has_more).toBe(false);
  });

  test("has_more is true when messages === limit", async () => {
    const limit = 10;
    const messages = Array.from({ length: limit }, (_, i) => ({
      id: `msg-${i}`,
    }));
    const { client } = makeClient([], messages);

    const resp = await handleBootstrapSessionState({
      bootstrapReq: { subtype: "bootstrap_session_state", limit },
      sessionContext: BASE_CTX,
      requestId: "req-8",
      client,
    });
    const payload = (resp.response as { response: Record<string, unknown> })
      .response;
    expect(payload.has_more).toBe(true);
  });

  test("next_before is last message id when messages present", async () => {
    const messages = [
      { id: "msg-newest" },
      { id: "msg-middle" },
      { id: "msg-oldest" },
    ];
    const { client } = makeClient([], messages);

    const resp = await handleBootstrapSessionState({
      bootstrapReq: { subtype: "bootstrap_session_state" },
      sessionContext: BASE_CTX,
      requestId: "req-9",
      client,
    });
    const payload = (resp.response as { response: Record<string, unknown> })
      .response;
    // Last item in array is oldest when order=desc
    expect(payload.next_before).toBe("msg-oldest");
  });

  test("next_before is null when no messages", async () => {
    const { client } = makeClient([], []);
    const resp = await handleBootstrapSessionState({
      bootstrapReq: { subtype: "bootstrap_session_state" },
      sessionContext: BASE_CTX,
      requestId: "req-10",
      client,
    });
    const payload = (resp.response as { response: Record<string, unknown> })
      .response;
    expect(payload.next_before).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Error path
// ─────────────────────────────────────────────────────────────────────────────

describe("bootstrap_session_state error handling", () => {
  test("client error returns error envelope", async () => {
    const throwingClient: BootstrapHandlerClient = {
      conversations: {
        messages: {
          list: async () => {
            throw new Error("Network timeout");
          },
        },
      },
      agents: {
        messages: {
          list: async () => {
            throw new Error("Network timeout");
          },
        },
      },
    };

    const resp = await handleBootstrapSessionState({
      bootstrapReq: { subtype: "bootstrap_session_state" },
      sessionContext: BASE_CTX,
      requestId: "req-err",
      client: throwingClient,
    });

    expect(resp.type).toBe("control_response");
    expect(resp.response.subtype).toBe("error");
    const errorResp = resp.response as {
      subtype: "error";
      error: string;
      request_id: string;
    };
    expect(errorResp.error).toContain("Network timeout");
    expect(errorResp.request_id).toBe("req-err");
  });
});
