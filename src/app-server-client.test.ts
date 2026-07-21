import { afterEach, describe, expect, test } from "bun:test";
import {
  type AppServerSocketLike,
  type AppServerSocketOptions,
  createAppServerClient,
  resolveAppServerChannelUrl,
} from "./app-server-client";

type Listener = (event: unknown) => void;

class FakeSocket implements AppServerSocketLike {
  static instances: FakeSocket[] = [];

  readyState = 0;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(
    readonly url: string,
    readonly options?: AppServerSocketOptions,
  ) {
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.emit("close", {});
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  open(): void {
    this.readyState = 1;
    this.emit("open", {});
  }

  receive(message: unknown): void {
    this.emit("message", { data: JSON.stringify(message) });
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

function createFakeClient() {
  const client = createAppServerClient({
    url: "http://127.0.0.1:4500",
    WebSocket: FakeSocket,
    requestTimeoutMs: 25,
  });
  const [control, stream] = FakeSocket.instances;
  if (!control || !stream) throw new Error("expected two sockets");
  return { client, control, stream };
}

describe("app-server client", () => {
  afterEach(() => {
    FakeSocket.instances = [];
  });

  test("resolves control and stream websocket URLs", () => {
    expect(resolveAppServerChannelUrl("http://127.0.0.1:4500", "control")).toBe(
      "ws://127.0.0.1:4500/ws?channel=control",
    );
    expect(
      resolveAppServerChannelUrl(
        "wss://example.test/ws?channel=control&token=abc",
        "stream",
      ),
    ).toBe("wss://example.test/ws?channel=stream&token=abc");
  });

  test("passes capability token as websocket authorization header", () => {
    createAppServerClient({
      url: "http://127.0.0.1:4500",
      authToken: " super-secret-token\n",
      WebSocket: FakeSocket,
    });
    const [control, stream] = FakeSocket.instances;
    expect(control?.options).toEqual({
      headers: { Authorization: "Bearer super-secret-token" },
    });
    expect(stream?.options).toEqual({
      headers: { Authorization: "Bearer super-secret-token" },
    });

    expect(() =>
      createAppServerClient({
        url: "http://127.0.0.1:4500",
        authToken: " \n",
        WebSocket: FakeSocket,
      }),
    ).toThrow(/auth token must not be empty/);
  });

  test("connects both sockets and resolves request_id responses", async () => {
    const { client, control, stream } = createFakeClient();
    const opened = client.connect();
    control.open();
    stream.open();
    await opened;

    const seen: string[] = [];
    client.onMessage((message, channel) => {
      seen.push(`${channel}:${message.type}`);
    });

    const responsePromise = client.runtimeStart({
      create_agent: { body: { name: "SDK test" } },
      create_conversation: { body: {} },
    });

    expect(JSON.parse(control.sent[0] ?? "{}")).toMatchObject({
      type: "runtime_start",
      request_id: "runtime-start-1",
      create_agent: { body: { name: "SDK test" } },
    });

    control.receive({
      type: "runtime_start_response",
      request_id: "runtime-start-1",
      success: true,
      runtime: { agent_id: "agent-1", conversation_id: "conv-1" },
      agent: { id: "agent-1" },
      conversation: { id: "conv-1" },
      created: { agent: true, conversation: true },
    });

    const response = await responsePromise;
    expect(response.runtime).toEqual({
      agent_id: "agent-1",
      conversation_id: "conv-1",
    });

    stream.receive({
      type: "update_loop_status",
      runtime: { agent_id: "agent-1", conversation_id: "conv-1" },
      event_seq: 1,
      emitted_at: "2026-06-11T00:00:00.000Z",
      idempotency_key: "evt-1",
      loop_status: { status: "WAITING_ON_INPUT", active_run_ids: [] },
    });
    expect(seen).toEqual([
      "control:runtime_start_response",
      "stream:update_loop_status",
    ]);
  });

  test("notifies once when either websocket disconnects unexpectedly", async () => {
    const { client, control, stream } = createFakeClient();
    control.open();
    stream.open();
    await client.connect();

    const disconnects: string[] = [];
    client.onDisconnect(({ channel }) => disconnects.push(channel));

    control.close();
    stream.close();

    expect(disconnects).toEqual(["control"]);
  });

  test("does not report explicit client shutdown as a disconnect", async () => {
    const { client, control, stream } = createFakeClient();
    control.open();
    stream.open();
    await client.connect();

    const disconnects: string[] = [];
    client.onDisconnect(({ channel }) => disconnects.push(channel));

    client.close();

    expect(disconnects).toEqual([]);
  });

  test("wraps sync, abort, and input commands", async () => {
    const { client, control, stream } = createFakeClient();
    control.open();
    stream.open();
    await client.connect();

    const sent: string[] = [];
    client.onSend((command) => {
      sent.push(command.type);
    });

    const runtime = { agent_id: "agent-1", conversation_id: "conv-1" };
    const syncPromise = client.sync({
      runtime,
      recover_approvals: false,
      force_device_status: true,
    });
    expect(JSON.parse(control.sent[0] ?? "{}")).toMatchObject({
      type: "sync",
      request_id: "sync-1",
      runtime,
    });
    control.receive({
      type: "sync_response",
      request_id: "sync-1",
      runtime,
      success: true,
    });
    expect((await syncPromise).success).toBe(true);

    const abortPromise = client.abort({ runtime });
    expect(JSON.parse(control.sent[1] ?? "{}")).toMatchObject({
      type: "abort_message",
      request_id: "abort-2",
      runtime,
    });
    control.receive({
      type: "abort_message_response",
      request_id: "abort-2",
      runtime,
      aborted: false,
      success: true,
    });
    expect((await abortPromise).aborted).toBe(false);

    client.input({
      runtime,
      payload: {
        kind: "create_message",
        messages: [{ role: "user", content: "hello" }],
      },
    });
    expect(JSON.parse(control.sent[2] ?? "{}")).toMatchObject({
      type: "input",
      runtime,
      payload: { kind: "create_message" },
    });
    expect(sent).toEqual(["sync", "abort_message", "input"]);
  });

  test("wraps conversation list requests", async () => {
    const { client, control, stream } = createFakeClient();
    control.open();
    stream.open();
    await client.connect();

    const responsePromise = client.conversationList({
      query: { agent_id: "agent-1", limit: 10 },
    });

    expect(JSON.parse(control.sent[0] ?? "{}")).toMatchObject({
      type: "conversation_list",
      request_id: "conversation-list-1",
      query: { agent_id: "agent-1", limit: 10 },
    });

    control.receive({
      type: "conversation_list_response",
      request_id: "conversation-list-1",
      success: true,
      conversations: [{ id: "conv-1", agent_id: "agent-1" }],
    });

    const response = await responsePromise;
    expect(response.success).toBe(true);
    expect(response.conversations).toEqual([
      { id: "conv-1", agent_id: "agent-1" },
    ]);
  });

  test("starts runtimes with external tools and responds to external tool calls", async () => {
    const { client, control, stream } = createFakeClient();
    control.open();
    stream.open();
    await client.connect();

    const runtimeStart = client.runtimeStart({
      create_agent: { body: { name: "SDK test" } },
      create_conversation: { body: {} },
      external_tools: [
        {
          scope_id: "scope-1",
          tools: [
            {
              name: "lookup_ticket",
              description: "Lookup a ticket",
              parameters: { type: "object", properties: {} },
            },
          ],
        },
      ],
    });

    expect(JSON.parse(control.sent[0] ?? "{}")).toMatchObject({
      type: "runtime_start",
      external_tools: [
        {
          scope_id: "scope-1",
          tools: [{ name: "lookup_ticket" }],
        },
      ],
    });
    control.receive({
      type: "runtime_start_response",
      request_id: "runtime-start-1",
      success: true,
      runtime: { agent_id: "agent-1", conversation_id: "conv-1" },
      agent: { id: "agent-1" },
      conversation: { id: "conv-1" },
      created: { agent: true, conversation: true },
    });
    await runtimeStart;

    client.onExternalToolCall((request) => ({
      content: [{ type: "text", text: `ticket:${request.input.id}` }],
    }));
    control.receive({
      type: "external_tool_call_request",
      request_id: "external-tool-1",
      runtime: { agent_id: "agent-1", conversation_id: "conv-1" },
      scope_id: "scope-1",
      tool_call_id: "call-1",
      tool_name: "lookup_ticket",
      input: { id: "ABC-123" },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(JSON.parse(control.sent.at(-1) ?? "{}")).toEqual({
      type: "external_tool_call_response",
      request_id: "external-tool-1",
      result: { content: [{ type: "text", text: "ticket:ABC-123" }] },
    });
  });

  test("runTurn injects client message ids and resolves on stop_reason", async () => {
    const { client, control, stream } = createFakeClient();
    control.open();
    stream.open();
    await client.connect();

    const runtime = { agent_id: "agent-1", conversation_id: "conv-1" };
    const turn = client.runTurn({
      runtime,
      payload: {
        kind: "create_message",
        messages: [{ role: "user", content: "hello" }],
      },
    });

    const sent = JSON.parse(control.sent[0] ?? "{}");
    expect(sent).toMatchObject({
      type: "input",
      runtime,
      payload: { kind: "create_message" },
    });
    expect(sent.payload.messages[0].client_message_id).toStartWith(
      "client-message-",
    );

    stream.receive({
      type: "stream_delta",
      runtime,
      event_seq: 1,
      emitted_at: "2026-06-11T00:00:00.000Z",
      idempotency_key: "stream-1",
      delta: {
        type: "message",
        message_type: "assistant_message",
        run_id: "run-1",
        content: [{ type: "text", text: "pong" }],
      },
    });
    stream.receive({
      type: "stream_delta",
      runtime,
      event_seq: 2,
      emitted_at: "2026-06-11T00:00:00.001Z",
      idempotency_key: "stream-2",
      delta: {
        type: "message",
        message_type: "stop_reason",
        run_id: "run-1",
        stop_reason: "end_turn",
      },
    });

    expect(await turn).toMatchObject({
      runtime,
      stopReason: "end_turn",
      runIds: ["run-1"],
      completedBy: "stop_reason",
    });
  });

  test("runTurn waits through intermediate requires_approval stop_reason", async () => {
    const { client, control, stream } = createFakeClient();
    control.open();
    stream.open();
    await client.connect();

    const runtime = { agent_id: "agent-1", conversation_id: "conv-1" };
    const turn = client.runTurn({
      runtime,
      payload: {
        kind: "create_message",
        messages: [{ role: "user", content: "use a tool" }],
      },
    });

    stream.receive({
      type: "stream_delta",
      runtime,
      event_seq: 1,
      emitted_at: "2026-06-11T00:00:00.000Z",
      idempotency_key: "stream-1",
      delta: {
        type: "message",
        message_type: "approval_request_message",
        run_id: "run-approval",
        tool_calls: [
          {
            tool_call_id: "call-1",
            name: "Bash",
            arguments: '{"command":"pwd"}',
          },
        ],
      },
    });
    stream.receive({
      type: "stream_delta",
      runtime,
      event_seq: 2,
      emitted_at: "2026-06-11T00:00:00.001Z",
      idempotency_key: "stream-2",
      delta: {
        type: "message",
        message_type: "stop_reason",
        run_id: "run-approval",
        stop_reason: "requires_approval",
      },
    });
    stream.receive({
      type: "update_loop_status",
      runtime,
      event_seq: 3,
      emitted_at: "2026-06-11T00:00:00.002Z",
      idempotency_key: "loop-1",
      loop_status: {
        status: "EXECUTING_CLIENT_SIDE_TOOL",
        active_run_ids: ["run-approval"],
      },
    });
    stream.receive({
      type: "stream_delta",
      runtime,
      event_seq: 4,
      emitted_at: "2026-06-11T00:00:00.003Z",
      idempotency_key: "stream-3",
      delta: {
        type: "message",
        message_type: "stop_reason",
        run_id: "run-final",
        stop_reason: "end_turn",
      },
    });

    expect(await turn).toMatchObject({
      runtime,
      stopReason: "end_turn",
      runIds: ["run-approval", "run-final"],
      completedBy: "stop_reason",
    });
  });

  test("runTurn resolves requires_approval only when listener is waiting on approval", async () => {
    const { client, control, stream } = createFakeClient();
    control.open();
    stream.open();
    await client.connect();

    const runtime = { agent_id: "agent-1", conversation_id: "conv-1" };
    const turn = client.runTurn({
      runtime,
      payload: {
        kind: "create_message",
        messages: [{ role: "user", content: "use a tool" }],
      },
    });

    stream.receive({
      type: "stream_delta",
      runtime,
      event_seq: 1,
      emitted_at: "2026-06-11T00:00:00.000Z",
      idempotency_key: "stream-1",
      delta: {
        type: "message",
        message_type: "approval_request_message",
        run_id: "run-approval",
        tool_calls: [
          {
            tool_call_id: "call-1",
            name: "Bash",
            arguments: '{"command":"rm -rf tmp"}',
          },
        ],
      },
    });
    stream.receive({
      type: "stream_delta",
      runtime,
      event_seq: 2,
      emitted_at: "2026-06-11T00:00:00.001Z",
      idempotency_key: "stream-2",
      delta: {
        type: "message",
        message_type: "stop_reason",
        run_id: "run-approval",
        stop_reason: "requires_approval",
      },
    });
    stream.receive({
      type: "update_loop_status",
      runtime,
      event_seq: 3,
      emitted_at: "2026-06-11T00:00:00.002Z",
      idempotency_key: "loop-1",
      loop_status: {
        status: "WAITING_ON_APPROVAL",
        active_run_ids: ["run-approval"],
      },
    });

    expect(await turn).toMatchObject({
      runtime,
      stopReason: "requires_approval",
      runIds: ["run-approval"],
      completedBy: "loop_status_waiting_on_approval",
    });
  });

  test("runTurn does not treat idle status alone as terminal", async () => {
    const { client, control, stream } = createFakeClient();
    control.open();
    stream.open();
    await client.connect();

    const runtime = { agent_id: "agent-1", conversation_id: "conv-1" };
    const turn = client.runTurn(
      {
        runtime,
        payload: {
          kind: "create_message",
          messages: [{ role: "user", content: "hello" }],
        },
      },
      { timeoutMs: 25, allowLoopStatusFallback: true },
    );

    stream.receive({
      type: "update_loop_status",
      runtime,
      event_seq: 1,
      emitted_at: "2026-06-11T00:00:00.000Z",
      idempotency_key: "loop-1",
      loop_status: { status: "WAITING_ON_INPUT", active_run_ids: [] },
    });

    await expect(turn).rejects.toThrow("Timed out waiting for app-server turn");
  });

  test("runTurn ignores waiting-on-approval status before turn evidence", async () => {
    const { client, control, stream } = createFakeClient();
    control.open();
    stream.open();
    await client.connect();

    const runtime = { agent_id: "agent-1", conversation_id: "conv-1" };
    const turn = client.runTurn(
      {
        runtime,
        payload: {
          kind: "create_message",
          messages: [{ role: "user", content: "hello" }],
        },
      },
      { allowLoopStatusFallback: true },
    );

    stream.receive({
      type: "update_loop_status",
      runtime,
      event_seq: 1,
      emitted_at: "2026-06-11T00:00:00.000Z",
      idempotency_key: "loop-1",
      loop_status: {
        status: "WAITING_ON_APPROVAL",
        active_run_ids: ["stale-run"],
      },
    });
    stream.receive({
      type: "stream_delta",
      runtime,
      event_seq: 2,
      emitted_at: "2026-06-11T00:00:00.001Z",
      idempotency_key: "stream-1",
      delta: {
        type: "message",
        message_type: "assistant_message",
        run_id: "run-1",
        content: "done",
      },
    });
    stream.receive({
      type: "stream_delta",
      runtime,
      event_seq: 3,
      emitted_at: "2026-06-11T00:00:00.002Z",
      idempotency_key: "stream-2",
      delta: {
        type: "message",
        message_type: "stop_reason",
        run_id: "run-1",
        stop_reason: "end_turn",
      },
    });

    expect(await turn).toMatchObject({
      runtime,
      stopReason: "end_turn",
      runIds: ["run-1"],
      completedBy: "stop_reason",
    });
  });

  test("runTurn rejects concurrent turns for the same runtime", async () => {
    const { client, control, stream } = createFakeClient();
    control.open();
    stream.open();
    await client.connect();

    const runtime = { agent_id: "agent-1", conversation_id: "conv-1" };
    const first = client.runTurn(
      {
        runtime,
        payload: {
          kind: "create_message",
          messages: [{ role: "user", content: "hello" }],
        },
      },
      { timeoutMs: 25 },
    );

    await expect(
      client.runTurn({
        runtime,
        payload: {
          kind: "create_message",
          messages: [{ role: "user", content: "again" }],
        },
      }),
    ).rejects.toThrow("A turn is already in flight for agent-1/conv-1");

    await expect(first).rejects.toThrow(
      "Timed out waiting for app-server turn",
    );
  });

  test("runTurn can use guarded loop-status fallback after run evidence", async () => {
    const { client, control, stream } = createFakeClient();
    control.open();
    stream.open();
    await client.connect();

    const runtime = { agent_id: "agent-1", conversation_id: "conv-1" };
    const turn = client.runTurn(
      {
        runtime,
        payload: {
          kind: "create_message",
          messages: [{ role: "user", content: "hello" }],
        },
      },
      { allowLoopStatusFallback: true },
    );

    stream.receive({
      type: "update_loop_status",
      runtime,
      event_seq: 1,
      emitted_at: "2026-06-11T00:00:00.000Z",
      idempotency_key: "loop-1",
      loop_status: {
        status: "PROCESSING_API_RESPONSE",
        active_run_ids: ["run-1"],
      },
    });
    stream.receive({
      type: "update_loop_status",
      runtime,
      event_seq: 2,
      emitted_at: "2026-06-11T00:00:00.001Z",
      idempotency_key: "loop-2",
      loop_status: { status: "WAITING_ON_INPUT", active_run_ids: [] },
    });

    expect(await turn).toMatchObject({
      runtime,
      stopReason: null,
      runIds: ["run-1"],
      completedBy: "loop_status_waiting_fallback",
    });
  });

  test("runTurn rejects on loop_error stream delta", async () => {
    const { client, control, stream } = createFakeClient();
    control.open();
    stream.open();
    await client.connect();

    const runtime = { agent_id: "agent-1", conversation_id: "conv-1" };
    const turn = client.runTurn({
      runtime,
      payload: {
        kind: "create_message",
        messages: [{ role: "user", content: "hello" }],
      },
    });

    stream.receive({
      type: "stream_delta",
      runtime,
      event_seq: 1,
      emitted_at: "2026-06-11T00:00:00.000Z",
      idempotency_key: "stream-1",
      delta: {
        id: "message-1",
        date: "2026-06-11T00:00:00.000Z",
        message_type: "loop_error",
        run_id: "run-1",
        message: "No API key for provider",
        stop_reason: "llm_api_error",
        is_terminal: false,
      },
    });

    await expect(turn).rejects.toThrow("No API key for provider");
  });

  test("supports ergonomic request construction", async () => {
    const { client, control, stream } = createFakeClient();
    control.open();
    stream.open();
    await client.connect();

    const responsePromise = client.request("agent_list", {
      query: { limit: 10 },
    });
    expect(JSON.parse(control.sent[0] ?? "{}")).toMatchObject({
      type: "agent_list",
      request_id: "agent_list-1",
      query: { limit: 10 },
    });

    control.receive({
      type: "agent_list_response",
      request_id: "agent_list-1",
      success: true,
      agents: [],
    });

    expect(await responsePromise).toMatchObject({
      type: "agent_list_response",
      success: true,
    });
  });

  test("times out unanswered requests", async () => {
    const { client, control, stream } = createFakeClient();
    control.open();
    stream.open();
    await client.connect();

    await expect(
      client.sync({
        runtime: { agent_id: "agent-1", conversation_id: "conv-1" },
      }),
    ).rejects.toThrow("Timed out waiting for sync-1");
  });
});
