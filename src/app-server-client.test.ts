import { afterEach, describe, expect, test } from "bun:test";
import {
  type AppServerSocketLike,
  type AppServerSocketOptions,
  createAppServerClient,
  isAppServerInfoResponseMessage,
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
  const [socket] = FakeSocket.instances;
  if (!socket) throw new Error("expected one socket");
  return { client, control: socket, stream: socket };
}

describe("app-server client", () => {
  afterEach(() => {
    FakeSocket.instances = [];
  });

  test("resolves historical channel names to the same websocket URL", () => {
    expect(resolveAppServerChannelUrl("http://127.0.0.1:4500", "control")).toBe(
      "ws://127.0.0.1:4500/ws",
    );
    expect(
      resolveAppServerChannelUrl(
        "wss://example.test/ws?channel=control&token=abc",
        "stream",
      ),
    ).toBe("wss://example.test/ws?token=abc");
  });

  test("passes capability token as websocket authorization header", () => {
    createAppServerClient({
      url: "http://127.0.0.1:4500",
      authToken: " super-secret-token\n",
      WebSocket: FakeSocket,
    });
    const [socket] = FakeSocket.instances;
    expect(socket?.options).toEqual({
      headers: { Authorization: "Bearer super-secret-token" },
    });
    expect(FakeSocket.instances).toHaveLength(1);

    expect(() =>
      createAppServerClient({
        url: "http://127.0.0.1:4500",
        authToken: " \n",
        WebSocket: FakeSocket,
      }),
    ).toThrow(/auth token must not be empty/);
  });

  test("requests App Server capabilities before starting a runtime", async () => {
    const { client, control } = createFakeClient();
    const opened = client.connect();
    control.open();
    await opened;

    const responsePromise = client.info();
    expect(JSON.parse(control.sent[0] ?? "{}")).toEqual({
      type: "app_server_info",
      request_id: "app-server-info-1",
    });

    control.receive({
      type: "app_server_info_response",
      request_id: "app-server-info-1",
      success: true,
      backend: "local",
      letta_code_version: "0.29.1",
      protocol_version: 1,
      capabilities: {
        agent_management: true,
        conversation_management: true,
        memory_management: true,
        runtime_start: true,
        runtime_external_tools_update: true,
        split_channels: false,
      },
    });

    await expect(responsePromise).resolves.toMatchObject({
      backend: "local",
      protocol_version: 1,
    });
  });

  test("validates the complete App Server capability response", () => {
    const response = {
      type: "app_server_info_response",
      request_id: "info-1",
      success: true,
      backend: "local",
      letta_code_version: "0.29.2",
      protocol_version: 2,
      capabilities: {
        agent_management: true,
        conversation_management: true,
        memory_management: true,
        runtime_start: true,
        split_channels: false,
      },
    };

    expect(isAppServerInfoResponseMessage(response)).toBe(true);
    expect(
      isAppServerInfoResponseMessage({
        ...response,
        capabilities: {
          agent_management: true,
          conversation_management: true,
          memory_management: true,
          runtime_start: true,
          split_channels: false,
        },
      }),
    ).toBe(true);
    expect(
      isAppServerInfoResponseMessage({
        ...response,
        capabilities: {
          ...response.capabilities,
          split_channels: "yes",
        },
      }),
    ).toBe(false);
    expect(
      isAppServerInfoResponseMessage({
        ...response,
        protocol_version: "2",
      }),
    ).toBe(false);
  });

  test("connects one socket and resolves request_id responses", async () => {
    const { client, control, stream } = createFakeClient();
    const opened = client.connect();
    control.open();
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
      "control:update_loop_status",
    ]);
  });

  test("notifies once when the websocket disconnects unexpectedly", async () => {
    const { client, control } = createFakeClient();
    control.open();
    await client.connect();

    const disconnects: string[] = [];
    client.onDisconnect(({ channel }) => disconnects.push(channel));

    control.close();
    expect(disconnects).toEqual(["control"]);
  });

  test("does not report explicit client shutdown as a disconnect", async () => {
    const { client, control } = createFakeClient();
    control.open();
    await client.connect();

    const disconnects: string[] = [];
    client.onDisconnect(({ channel }) => disconnects.push(channel));

    client.close();

    expect(disconnects).toEqual([]);
  });

  test("wraps sync, abort, and input commands", async () => {
    const { client, control } = createFakeClient();
    control.open();
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

    const toolUpdatePromise = client.runtimeExternalToolsUpdate({
      updates: [
        {
          runtimes: [runtime],
          external_tools: [
            {
              tools: [
                {
                  name: "MessageChannel",
                  description: "Deliver a channel message",
                  parameters: { type: "object", properties: {} },
                },
              ],
            },
          ],
        },
      ],
    });
    expect(JSON.parse(control.sent[1] ?? "{}")).toMatchObject({
      type: "runtime_external_tools_update",
      request_id: "runtime-external-tools-2",
      updates: [{ runtimes: [runtime] }],
    });
    control.receive({
      type: "runtime_external_tools_update_response",
      request_id: "runtime-external-tools-2",
      success: true,
    });
    expect((await toolUpdatePromise).success).toBe(true);

    const abortPromise = client.abort({ runtime });
    expect(JSON.parse(control.sent[2] ?? "{}")).toMatchObject({
      type: "abort_message",
      request_id: "abort-3",
      runtime,
    });
    control.receive({
      type: "abort_message_response",
      request_id: "abort-3",
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
    expect(JSON.parse(control.sent[3] ?? "{}")).toMatchObject({
      type: "input",
      runtime,
      payload: { kind: "create_message" },
    });
    expect(sent).toEqual([
      "sync",
      "runtime_external_tools_update",
      "abort_message",
      "input",
    ]);
  });

  test("wraps conversation list requests", async () => {
    const { client, control } = createFakeClient();
    control.open();
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
    const { client, control } = createFakeClient();
    control.open();
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

  test("supports ergonomic request construction", async () => {
    const { client, control } = createFakeClient();
    control.open();
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

  test("supports forward-compatible compatibility adapter requests", async () => {
    const client = createAppServerClient({
      url: "ws://127.0.0.1:4500",
      WebSocket: FakeSocket,
    });
    const sent: string[] = [];
    client.onSend((command) => sent.push(command.type));

    const pending = client.requestRaw<{ type: string; request_id: string }>(
      {
        type: "future_command",
        request_id: "future-1",
      },
      {
        predicate: (
          message,
        ): message is {
          type: string;
          request_id: string;
        } =>
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "future_response",
      },
    );
    expect(sent).toEqual(["future_command"]);

    FakeSocket.instances[0]?.receive({
      type: "future_response",
      request_id: "future-1",
    });

    await expect(pending).resolves.toEqual({
      type: "future_response",
      request_id: "future-1",
    });
  });

  test("times out unanswered requests", async () => {
    const { client, control } = createFakeClient();
    control.open();
    await client.connect();

    await expect(
      client.sync({
        runtime: { agent_id: "agent-1", conversation_id: "conv-1" },
      }),
    ).rejects.toThrow("Timed out waiting for sync-1");
  });
});
