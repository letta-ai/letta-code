import { afterEach, describe, expect, test } from "bun:test";
import {
  type AppServerSocketLike,
  createAppServerClient,
  resolveAppServerChannelUrl,
} from "./app-server-client";

type Listener = (event: unknown) => void;

class FakeSocket implements AppServerSocketLike {
  static instances: FakeSocket[] = [];

  readyState = 0;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(readonly url: string) {
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

describe("app-server client helper", () => {
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

  test("wraps sync, abort, and input commands", async () => {
    const { client, control, stream } = createFakeClient();
    control.open();
    stream.open();
    await client.connect();

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
