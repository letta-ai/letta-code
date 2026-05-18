/**
 * Handler-level tests for list_messages using mock backends.
 *
 * These tests call handleListMessages() directly with mock implementations
 * of backend.listConversationMessages.  They verify:
 *
 * 1. Which backend method is called for each routing case (explicit conv,
 *    omitted+named session conv, omitted+default session conv)
 * 2. The arguments passed to each backend method
 * 3. The shape and content of the returned ControlResponse
 * 4. Error path — backend throws, handler returns error envelope
 *
 * No network. No CLI subprocess. No process.stdout.
 */
import { describe, expect, mock, test } from "bun:test";
import type { ListMessagesHandlerBackend } from "../../agent/listMessagesHandler";
import { handleListMessages } from "../../agent/listMessagesHandler";

// ─────────────────────────────────────────────────────────────────────────────
// Mock factory
// ─────────────────────────────────────────────────────────────────────────────

function makeBackend(convMessages: unknown[] = []): {
  backend: ListMessagesHandlerBackend;
  convListSpy: ReturnType<typeof mock>;
} {
  const convListSpy = mock(async () => ({
    getPaginatedItems: () => convMessages,
  }));

  const backend: ListMessagesHandlerBackend = {
    listConversationMessages:
      convListSpy as unknown as ListMessagesHandlerBackend["listConversationMessages"],
  };

  return { backend, convListSpy };
}

const BASE = {
  sessionId: "sess-test",
  requestId: "req-test-001",
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Routing: which backend method is called
// ─────────────────────────────────────────────────────────────────────────────

describe("handleListMessages — routing (which backend method is called)", () => {
  test("explicit conversation_id → calls backend.listConversationMessages with that id", async () => {
    const { backend, convListSpy } = makeBackend([{ id: "m1" }]);

    const resp = await handleListMessages({
      ...BASE,
      listReq: { subtype: "list_messages", conversation_id: "conv-explicit" },
      sessionConversationId: "default",
      sessionAgentId: "agent-session",
      backend,
    });

    expect(convListSpy).toHaveBeenCalledTimes(1);
    expect(convListSpy.mock.calls[0]?.[0]).toBe("conv-explicit");
    expect(resp.response.subtype).toBe("success");
  });

  test("explicit conversation_id overrides a non-default session conv", async () => {
    const { backend, convListSpy } = makeBackend([]);

    await handleListMessages({
      ...BASE,
      listReq: { subtype: "list_messages", conversation_id: "conv-override" },
      sessionConversationId: "conv-session-other",
      sessionAgentId: "agent-session",
      backend,
    });

    expect(convListSpy.mock.calls[0]?.[0]).toBe("conv-override");
  });

  test("omitted conversation_id + named session conv → calls backend.listConversationMessages with session conv", async () => {
    const { backend, convListSpy } = makeBackend([
      { id: "msg-A" },
      { id: "msg-B" },
    ]);

    const resp = await handleListMessages({
      ...BASE,
      listReq: { subtype: "list_messages" }, // no conversation_id
      sessionConversationId: "conv-session-xyz",
      sessionAgentId: "agent-session",
      backend,
    });

    expect(convListSpy).toHaveBeenCalledTimes(1);
    expect(convListSpy.mock.calls[0]?.[0]).toBe("conv-session-xyz");
    expect(resp.response.subtype).toBe("success");
    if (resp.response.subtype === "success") {
      const payload = resp.response.response as {
        messages: unknown[];
        has_more: boolean;
      };
      expect(payload.messages).toHaveLength(2);
    }
  });

  test("omitted conversation_id + session on default → calls backend.listConversationMessages with default + agent_id", async () => {
    const { backend, convListSpy } = makeBackend([{ id: "msg-default-1" }]);

    const resp = await handleListMessages({
      ...BASE,
      listReq: { subtype: "list_messages" }, // no conversation_id
      sessionConversationId: "default",
      sessionAgentId: "agent-def",
      backend,
    });

    expect(convListSpy).toHaveBeenCalledTimes(1);
    expect(convListSpy.mock.calls[0]?.[0]).toBe("default");
    const opts = convListSpy.mock.calls[0]?.[1] as { agent_id?: string };
    expect(opts.agent_id).toBe("agent-def");
    expect(resp.response.subtype).toBe("success");
  });

  test("explicit agent_id + session default → conversations path uses request agent_id query", async () => {
    const { backend, convListSpy } = makeBackend([]);

    await handleListMessages({
      ...BASE,
      listReq: { subtype: "list_messages", agent_id: "agent-override" },
      sessionConversationId: "default",
      sessionAgentId: "agent-session",
      backend,
    });

    expect(convListSpy.mock.calls[0]?.[0]).toBe("default");
    const opts = convListSpy.mock.calls[0]?.[1] as { agent_id?: string };
    expect(opts.agent_id).toBe("agent-override");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Args forwarding: limit, order, cursor options
// ─────────────────────────────────────────────────────────────────────────────

describe("handleListMessages — backend call arguments", () => {
  test("passes limit and order to conversations path", async () => {
    const { backend, convListSpy } = makeBackend([]);

    await handleListMessages({
      ...BASE,
      listReq: {
        subtype: "list_messages",
        conversation_id: "conv-1",
        limit: 25,
        order: "asc",
      },
      sessionConversationId: "default",
      sessionAgentId: "agent-1",
      backend,
    });

    const opts = convListSpy.mock.calls[0]?.[1] as {
      limit: number;
      order: string;
    };
    expect(opts.limit).toBe(25);
    expect(opts.order).toBe("asc");
  });

  test("defaults to limit=50 and order=desc when not specified", async () => {
    const { backend, convListSpy } = makeBackend([]);

    await handleListMessages({
      ...BASE,
      listReq: { subtype: "list_messages" },
      sessionConversationId: "default",
      sessionAgentId: "agent-1",
      backend,
    });

    expect(convListSpy.mock.calls[0]?.[0]).toBe("default");
    const opts = convListSpy.mock.calls[0]?.[1] as {
      agent_id?: string;
      limit: number;
      order: string;
    };
    expect(opts.agent_id).toBe("agent-1");
    expect(opts.limit).toBe(50);
    expect(opts.order).toBe("desc");
  });

  test("forwards before cursor to conversations path", async () => {
    const { backend, convListSpy } = makeBackend([]);

    await handleListMessages({
      ...BASE,
      listReq: {
        subtype: "list_messages",
        conversation_id: "conv-1",
        before: "msg-cursor",
      },
      sessionConversationId: "default",
      sessionAgentId: "agent-1",
      backend,
    });

    const opts = convListSpy.mock.calls[0]?.[1] as { before?: string };
    expect(opts.before).toBe("msg-cursor");
  });

  test("forwards before cursor to default conversation path", async () => {
    const { backend, convListSpy } = makeBackend([]);

    await handleListMessages({
      ...BASE,
      listReq: { subtype: "list_messages", before: "msg-cursor-agents" },
      sessionConversationId: "default",
      sessionAgentId: "agent-1",
      backend,
    });

    expect(convListSpy.mock.calls[0]?.[0]).toBe("default");
    const opts = convListSpy.mock.calls[0]?.[1] as {
      agent_id?: string;
      before?: string;
    };
    expect(opts.agent_id).toBe("agent-1");
    expect(opts.before).toBe("msg-cursor-agents");
  });

  test("does not include before/after when absent", async () => {
    const { backend, convListSpy } = makeBackend([]);

    await handleListMessages({
      ...BASE,
      listReq: { subtype: "list_messages", conversation_id: "conv-1" },
      sessionConversationId: "default",
      sessionAgentId: "agent-1",
      backend,
    });

    const opts = convListSpy.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(opts.before).toBeUndefined();
    expect(opts.after).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Response shape
// ─────────────────────────────────────────────────────────────────────────────

describe("handleListMessages — response shape", () => {
  test("success response has correct envelope", async () => {
    const msgs = [{ id: "m1" }, { id: "m2" }];
    const { backend } = makeBackend(msgs);

    const resp = await handleListMessages({
      ...BASE,
      listReq: { subtype: "list_messages", conversation_id: "conv-1" },
      sessionConversationId: "default",
      sessionAgentId: "agent-1",
      backend,
    });

    expect(resp.type).toBe("control_response");
    expect(resp.session_id).toBe(BASE.sessionId);
    expect(resp.response.subtype).toBe("success");
    expect(resp.response.request_id).toBe(BASE.requestId);
    if (resp.response.subtype === "success") {
      const payload = resp.response.response as {
        messages: unknown[];
        has_more: boolean;
        next_before: string | null;
      };
      expect(payload.messages).toHaveLength(2);
      expect(payload.has_more).toBe(false); // 2 < 50
      expect(payload.next_before).toBe("m2"); // last item id
    }
  });

  test("has_more is true when result length equals limit", async () => {
    const msgs = Array.from({ length: 50 }, (_, i) => ({ id: `m${i}` }));
    const { backend } = makeBackend(msgs);

    const resp = await handleListMessages({
      ...BASE,
      listReq: {
        subtype: "list_messages",
        conversation_id: "conv-1",
        limit: 50,
      },
      sessionConversationId: "default",
      sessionAgentId: "agent-1",
      backend,
    });

    if (resp.response.subtype === "success") {
      const payload = resp.response.response as { has_more: boolean };
      expect(payload.has_more).toBe(true);
    }
  });

  test("next_before is null when result is empty", async () => {
    const { backend } = makeBackend([]);

    const resp = await handleListMessages({
      ...BASE,
      listReq: { subtype: "list_messages", conversation_id: "conv-1" },
      sessionConversationId: "default",
      sessionAgentId: "agent-1",
      backend,
    });

    if (resp.response.subtype === "success") {
      const payload = resp.response.response as { next_before: null };
      expect(payload.next_before).toBeNull();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Error path
// ─────────────────────────────────────────────────────────────────────────────

describe("handleListMessages — error path", () => {
  test("backend Error → error control_response with message", async () => {
    const convListSpy = mock(async () => {
      throw new Error("404 conversation not found");
    });
    const backend: ListMessagesHandlerBackend = {
      listConversationMessages:
        convListSpy as unknown as ListMessagesHandlerBackend["listConversationMessages"],
    };

    const resp = await handleListMessages({
      ...BASE,
      listReq: { subtype: "list_messages", conversation_id: "conv-bad" },
      sessionConversationId: "default",
      sessionAgentId: "agent-1",
      backend,
    });

    expect(resp.response.subtype).toBe("error");
    if (resp.response.subtype === "error") {
      expect(resp.response.error).toContain("404 conversation not found");
      expect(resp.response.request_id).toBe(BASE.requestId);
    }
  });

  test("non-Error throw → generic fallback message", async () => {
    const convListSpy = mock(async () => {
      throw "string error";
    });
    const backend: ListMessagesHandlerBackend = {
      listConversationMessages:
        convListSpy as unknown as ListMessagesHandlerBackend["listConversationMessages"],
    };

    const resp = await handleListMessages({
      ...BASE,
      listReq: { subtype: "list_messages", conversation_id: "conv-1" },
      sessionConversationId: "default",
      sessionAgentId: "agent-1",
      backend,
    });

    if (resp.response.subtype === "error") {
      expect(resp.response.error).toBe("list_messages failed");
    }
  });

  test("default conversation error → error envelope with correct session_id", async () => {
    const convListSpy = mock(async () => {
      throw new Error("agent unavailable");
    });
    const backend: ListMessagesHandlerBackend = {
      listConversationMessages:
        convListSpy as unknown as ListMessagesHandlerBackend["listConversationMessages"],
    };

    const resp = await handleListMessages({
      sessionId: "my-session",
      requestId: "req-err",
      listReq: { subtype: "list_messages" },
      sessionConversationId: "default",
      sessionAgentId: "agent-1",
      backend,
    });

    expect(resp.session_id).toBe("my-session");
    expect(resp.response.subtype).toBe("error");
    if (resp.response.subtype === "error") {
      expect(resp.response.error).toBe("agent unavailable");
    }
  });
});
