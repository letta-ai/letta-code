import { describe, expect, test } from "bun:test";
import type { InputCreateMessagePayload } from "@/types/protocol_v2";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { markCoreOwned, prepareRuntimeInputCommand } from "./input-state";
import { createRuntime } from "./lifecycle";
import type { ListenerTransport } from "./transport";
import type { ConversationRuntime, IncomingMessage } from "./types";

function payload(content = "hello"): InputCreateMessagePayload {
  return {
    kind: "create_message",
    messages: [
      {
        role: "user",
        content,
        client_message_id: "cm-1",
      },
    ],
  };
}

function incoming(): IncomingMessage {
  return {
    type: "message",
    agentId: "agent-1",
    conversationId: "conv-1",
    messages: [],
  };
}

function prepare(
  runtime: ConversationRuntime,
  value: InputCreateMessagePayload,
  requestId: string,
) {
  return prepareRuntimeInputCommand(runtime, value, requestId, incoming());
}

function setup() {
  const listener = createRuntime();
  listener.transport = {
    readyState: 1,
    send: () => {},
  } as unknown as ListenerTransport;
  const emitted: Array<Record<string, unknown>> = [];
  listener.streamObservers = new Set([
    (message) => emitted.push(message as Record<string, unknown>),
  ]);
  const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
  return { runtime, emitted };
}

describe("correlated runtime input state", () => {
  test("replays known admission without creating another input", () => {
    const { runtime, emitted } = setup();
    const first = prepare(runtime, payload(), "req-1");
    expect(first).not.toBeNull();
    first?.onAdmitted("direct");

    expect(prepare(runtime, payload(), "req-2")).toBeNull();
    expect(emitted.map((event) => event.status)).toEqual([
      "admitted",
      "admitted",
    ]);
    expect(emitted.at(-1)).toMatchObject({
      request_id: "req-2",
      client_message_id: "cm-1",
      admission: "direct",
    });
  });

  test("rejects reuse of a client id with a different payload", () => {
    const { runtime, emitted } = setup();
    prepare(runtime, payload(), "req-1");

    expect(prepare(runtime, payload("different"), "req-2")).toBeNull();
    expect(emitted.at(-1)).toMatchObject({
      request_id: "req-2",
      client_message_id: "cm-1",
      status: "rejected",
    });
  });

  test("reports drop and permits the same receipt to retry", () => {
    const { runtime, emitted } = setup();
    const first = prepare(runtime, payload(), "req-1");
    first?.onAdmitted("queued");
    first?.onDropped("buffer_limit");

    const retry = prepare(runtime, payload(), "req-2");
    expect(retry).not.toBeNull();
    retry?.onAdmitted("queued");
    expect(emitted.map((event) => event.status)).toEqual([
      "admitted",
      "dropped",
      "admitted",
    ]);
  });

  test("settles every correlated input on Core ownership", () => {
    const { runtime, emitted } = setup();
    const multiPayload: InputCreateMessagePayload = {
      kind: "create_message",
      messages: [
        { role: "user", content: "a", client_message_id: "cm-a" },
        { role: "user", content: "b", client_message_id: "cm-b" },
      ],
    };
    const prepared = prepare(runtime, multiPayload, "req-1");
    prepared?.onAdmitted("queued");
    markCoreOwned(runtime, ["cm-a", "cm-b"], "run-1");

    expect(
      emitted
        .filter((event) => event.status === "core_owned")
        .map((event) => event.client_message_id),
    ).toEqual(["cm-a", "cm-b"]);
    expect(emitted.at(-1)).toMatchObject({ run_id: "run-1" });
  });
});
