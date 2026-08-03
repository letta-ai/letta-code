import { describe, expect, test } from "bun:test";
import type { InputCreateMessagePayload } from "@/types/protocol_v2";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import {
  getRuntimeInputRunId,
  markCoreOwned,
  prepareRuntimeInputCommand,
} from "./input-state";
import { createRuntime } from "./lifecycle";
import { evictConversationRuntimeIfIdle } from "./runtime";
import type { ListenerTransport } from "./transport";
import { handleIncomingMessage } from "./turn";
import type { ConversationRuntime, IncomingMessage } from "./types";

function payload(
  content = "hello",
  clientMessageId = "cm-1",
): InputCreateMessagePayload {
  return {
    kind: "create_message",
    messages: [
      {
        role: "user",
        content,
        client_message_id: clientMessageId,
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
  test("accepts a run id carried only by stream error metadata", () => {
    expect(getRuntimeInputRunId({}, { run_id: "run-error" })).toBe("run-error");
    expect(
      getRuntimeInputRunId({ run_id: "run-chunk" }, { run_id: "run-error" }),
    ).toBe("run-chunk");
  });

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
    expect(
      emitted.filter((event) => event.type === "runtime_input_state").at(-1),
    ).toMatchObject({
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

  test("treats object key order as the same retry payload", () => {
    const { runtime, emitted } = setup();
    const first = prepare(runtime, payload(), "req-1");
    first?.onAdmitted("direct");
    const reordered: InputCreateMessagePayload = {
      messages: [
        {
          client_message_id: "cm-1",
          content: "hello",
          role: "user",
        },
      ],
      kind: "create_message",
    };

    expect(prepare(runtime, reordered, "req-2")).toBeNull();
    expect(emitted.at(-1)).toMatchObject({
      request_id: "req-2",
      status: "admitted",
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

  test("replays settled state after the idle conversation runtime is evicted", () => {
    const listener = createRuntime();
    listener.transport = {
      readyState: 1,
      send: () => {},
    } as unknown as ListenerTransport;
    const emitted: Array<Record<string, unknown>> = [];
    listener.streamObservers = new Set([
      (message) => emitted.push(message as Record<string, unknown>),
    ]);
    const firstRuntime = getOrCreateScopedRuntime(
      listener,
      "agent-1",
      "conv-1",
    );
    const first = prepare(firstRuntime, payload(), "req-1");
    first?.onAdmitted("direct");
    markCoreOwned(firstRuntime, ["cm-1"], "run-1");
    expect(evictConversationRuntimeIfIdle(firstRuntime)).toBe(true);

    const replacementRuntime = getOrCreateScopedRuntime(
      listener,
      "agent-1",
      "conv-1",
    );
    expect(prepare(replacementRuntime, payload(), "req-2")).toBeNull();
    expect(emitted.at(-1)).toMatchObject({
      request_id: "req-2",
      client_message_id: "cm-1",
      status: "core_owned",
      run_id: "run-1",
    });
  });

  test("never evicts unsettled dedupe state at capacity", () => {
    const { runtime, emitted } = setup();
    for (let index = 0; index < 4096; index += 1) {
      expect(
        prepare(
          runtime,
          payload(`message-${index}`, `cm-${index}`),
          `req-${index}`,
        ),
      ).not.toBeNull();
    }

    expect(
      prepare(runtime, payload("overflow", "cm-overflow"), "req-overflow"),
    ).toBeNull();
    expect(emitted.at(-1)).toMatchObject({
      request_id: "req-overflow",
      client_message_id: "cm-overflow",
      status: "rejected",
      error: "Listener input dedupe capacity reached",
    });
    expect(
      prepare(runtime, payload("message-0", "cm-0"), "req-retry"),
    ).toBeNull();
    expect(
      runtime.listener.runtimeInputStates?.has(`${runtime.key}::cm-0`),
    ).toBe(true);
  });

  test("drops admitted input when a turn ends before Core owns it", async () => {
    const listener = createRuntime();
    const transport = {
      readyState: 1,
      send: () => {},
    } as unknown as ListenerTransport;
    listener.transport = transport;
    const emitted: Array<Record<string, unknown>> = [];
    listener.streamObservers = new Set([
      (message) => emitted.push(message as Record<string, unknown>),
    ]);
    const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
    const input = payload();
    const turnInput: IncomingMessage = {
      ...incoming(),
      messages: input.messages,
    };
    const prepared = prepareRuntimeInputCommand(
      runtime,
      input,
      "req-1",
      turnInput,
    );
    prepared?.onAdmitted("direct");
    const lease = runtime.turnLifecycle.begin({
      origin: "message",
      workingDirectory: process.cwd(),
    });
    runtime.turnLifecycle.requestCancellation();

    await handleIncomingMessage(
      turnInput,
      transport,
      runtime,
      undefined,
      undefined,
      "batch-1",
      lease,
    );

    expect(
      emitted.filter((event) => event.type === "runtime_input_state").at(-1),
    ).toMatchObject({
      request_id: "req-1",
      client_message_id: "cm-1",
      status: "dropped",
      error: "Listener turn ended before Core ownership",
    });
  });
});
