import { afterEach, describe, expect, test } from "bun:test";
import type WebSocket from "ws";
import { resetMcpOriginatorAuthority } from "@/agent/mcp-originator-authority";
import {
  clearMcpOriginatorTokens,
  deleteMcpOriginatorToken,
  getMcpOriginatorToken,
  mcpOriginatorTokenCount,
  setMcpOriginatorToken,
} from "@/agent/mcp-originator-tokens";
import { createBuffers } from "@/cli/helpers/accumulator";
import { clearExternalTools } from "@/tools/manager";
import {
  markListenerConnectionInitialized,
  openListenerConnection,
  subscribeListenerConnection,
} from "./connection";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { enqueueInboundUserMessage } from "./inbound-queue";
import { ordinaryInputIdentity } from "./input-disposition";
import { completeInputReplay } from "./input-terminal-journal";
import { createRuntime } from "./lifecycle";
import { getMcpOriginatorScope } from "./mcp-originator-scope";
import { createListenerMessageHandler } from "./message-router";
import { consumeQueuedTurn } from "./queue";
import { setActiveRuntime } from "./runtime";
import { safeSocketSend } from "./socket-send";
import type { ListenerTransport } from "./transport";
import { createTurnCorrelation } from "./turn-correlation";
import { createTurnDurabilityOwnership } from "./turn-durability-ownership";
import { createTurnFinalizer } from "./turn-finalizer";
import type {
  IncomingMessage,
  ListenerRuntime,
  StartListenerOptions,
} from "./types";

class MockSocket {
  readyState = 1;
  sentPayloads: string[] = [];

  send(payload: string): void {
    this.sentPayloads.push(payload);
  }
}

function makeListenerOptions(): StartListenerOptions {
  return {
    connectionId: "conn-test",
    wsUrl: "wss://example.test/ws",
    deviceId: "device-test",
    connectionName: "listener-test",
    onConnected: () => {},
    onDisconnected: () => {},
    onError: () => {},
  };
}

function initializeMockConnection(
  listener: ListenerRuntime,
  socket: MockSocket,
): void {
  const connection = openListenerConnection({
    runtime: listener,
    connectionId: "conn-test",
    writer: socket as unknown as WebSocket,
    options: makeListenerOptions(),
  });
  markListenerConnectionInitialized(listener, "conn-test", connection);
  subscribeListenerConnection(listener, "conn-test", {
    agent_id: "agent-1",
    conversation_id: "conv-1",
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await Bun.sleep(1);
  }
  throw new Error("Timed out waiting for listener state");
}

function buildHandler(
  listener: ListenerRuntime,
  socket: MockSocket,
  processed: IncomingMessage[],
) {
  return createListenerMessageHandler({
    runtime: listener,
    socket: socket as unknown as WebSocket,
    opts: makeListenerOptions(),
    processQueuedTurn: async () => {},
    fileCommandSession: { handle: () => false },
    getParsedRuntimeScope: () => null,
    replaySyncStateForRuntime: async () => {},
    getOrCreateScopedRuntime,
    handleApprovalResponseInput: async () => false,
    handleChangeDeviceStateInput: async () => false,
    handleAbortMessageInput: async () => false,
    stampInboundUserMessageOtids: (incoming) => incoming,
    safeSocketSend,
    runDetachedListenerTask: (_label, task) => {
      void task();
    },
    trackListenerError: (error) => {
      throw error;
    },
    processIncomingMessage: async (incoming) => {
      processed.push(incoming);
    },
  });
}

function inputFrame(
  fields: Record<string, unknown>,
  requestId = "req-1",
): Buffer {
  // The relay contract (letta-cloud #18881): super_run_id and
  // mcp_originator_token ride the TOP-LEVEL input frame, never inside the
  // user-message payload — the payload is persisted and bearer material must
  // stay off durable records. Other fields (e.g. client_message_id) belong
  // to the payload.
  const {
    super_run_id,
    mcp_originator_token,
    client_message_id,
    ...payloadFields
  } = fields;
  return Buffer.from(
    JSON.stringify({
      type: "input",
      request_id: requestId,
      runtime: { agent_id: "agent-1", conversation_id: "conv-1" },
      ...(super_run_id !== undefined ? { super_run_id } : {}),
      ...(mcp_originator_token !== undefined ? { mcp_originator_token } : {}),
      payload: {
        kind: "create_message",
        messages: [
          {
            role: "user",
            content: "hello",
            ...(client_message_id !== undefined ? { client_message_id } : {}),
          },
        ],
        ...payloadFields,
      },
    }),
  );
}

afterEach(() => {
  clearMcpOriginatorTokens();
  resetMcpOriginatorAuthority();
  clearExternalTools();
  setActiveRuntime(null);
});

describe("MCP originator token ingestion", () => {
  test("holds a delivered token in memory and carries only the id on the message", async () => {
    const listener = createRuntime();
    const socket = new MockSocket();
    initializeMockConnection(listener, socket);
    setActiveRuntime(listener);
    const processed: IncomingMessage[] = [];
    const handleMessage = buildHandler(listener, socket, processed);

    await handleMessage(
      inputFrame({
        super_run_id: "sr-1",
        mcp_originator_token: "mst_one.secret-a",
      }),
    );

    expect(getMcpOriginatorToken("sr-1")).toBe("mst_one.secret-a");
    await waitFor(() => processed.length === 1);
    expect(processed[0]?.mcpOriginatorSuperRunId).toBe("sr-1");
    expect(processed[0]?.mcpOriginatorTokenPresent).toBe(true);
    // The IncomingMessage rides the durable input ledger: the token value
    // must never appear anywhere on it.
    expect(JSON.stringify(processed[0])).not.toContain("mst_one.secret-a");
    expect("mcpOriginatorToken" in (processed[0] ?? {})).toBe(false);
  });

  test("payload-carried delivery fields are ignored; only the top-level frame counts", async () => {
    // The relay contract puts the delivery on the top-level input frame.
    // Fields smuggled inside the user-message payload (which is persisted)
    // must be ignored, not honored (letta-cloud #18881 shape).
    const listener = createRuntime();
    const socket = new MockSocket();
    initializeMockConnection(listener, socket);
    setActiveRuntime(listener);
    const processed: IncomingMessage[] = [];
    const handleMessage = buildHandler(listener, socket, processed);

    await handleMessage(
      Buffer.from(
        JSON.stringify({
          type: "input",
          request_id: "req-payload-smuggle",
          runtime: { agent_id: "agent-1", conversation_id: "conv-1" },
          payload: {
            kind: "create_message",
            super_run_id: "sr-smuggle",
            mcp_originator_token: "mst_smuggle.secret-x",
            messages: [{ role: "user", content: "hello" }],
          },
        }),
      ),
    );

    await waitFor(() => processed.length === 1);
    expect(processed[0]?.mcpOriginatorSuperRunId).toBeUndefined();
    expect(getMcpOriginatorToken("sr-smuggle")).toBeUndefined();
    expect(mcpOriginatorTokenCount()).toBe(0);
  });

  test("a duplicate re-ack refreshes the live run's re-minted token", async () => {
    // ACK loss makes the relay redeliver the SAME input bearing a freshly
    // minted token (the prior token is revoked server-side); the refresh
    // must update the live entry in place or the turn's next tool call
    // would present a dead token (evil-shub r4300657683).
    const listener = createRuntime();
    const socket = new MockSocket();
    initializeMockConnection(listener, socket);
    setActiveRuntime(listener);
    const processed: IncomingMessage[] = [];
    const handleMessage = buildHandler(listener, socket, processed);

    await handleMessage(
      inputFrame({
        client_message_id: "m-1",
        super_run_id: "sr-1",
        mcp_originator_token: "mst_one.secret-a",
      }),
    );
    await waitFor(() => processed.length === 1);
    expect(getMcpOriginatorToken("sr-1")).toBe("mst_one.secret-a");

    await handleMessage(
      inputFrame(
        {
          client_message_id: "m-1",
          super_run_id: "sr-1",
          mcp_originator_token: "mst_one.secret-b",
        },
        "req-2",
      ),
    );
    await waitFor(() => getMcpOriginatorToken("sr-1") === "mst_one.secret-b");
    // The duplicate created no new work.
    expect(processed.length).toBe(1);
  });

  test("a duplicate re-ack with a LIVE durable owner may recreate the token (crash recovery)", async () => {
    const listener = createRuntime();
    const socket = new MockSocket();
    initializeMockConnection(listener, socket);
    setActiveRuntime(listener);
    const processed: IncomingMessage[] = [];
    const handleMessage = buildHandler(listener, socket, processed);

    await handleMessage(
      inputFrame({
        client_message_id: "m-1",
        super_run_id: "sr-1",
        mcp_originator_token: "mst_one.secret-a",
      }),
    );
    await waitFor(() => processed.length === 1);
    expect(getMcpOriginatorToken("sr-1")).toBe("mst_one.secret-a");

    // Process crash: the volatile token entry is lost but the durable ledger
    // still shows the live accepted owner. The re-delivered (re-minted)
    // duplicate MAY recreate the entry — otherwise recovered work runs
    // headerless on the unrestricted MCP path.
    deleteMcpOriginatorToken("sr-1");
    await handleMessage(
      inputFrame(
        {
          client_message_id: "m-1",
          super_run_id: "sr-1",
          mcp_originator_token: "mst_one.secret-b",
        },
        "req-2",
      ),
    );
    await waitFor(() => getMcpOriginatorToken("sr-1") === "mst_one.secret-b");
    expect(processed.length).toBe(1);
  });

  test("a duplicate re-ack after a TERMINAL disposition cannot resurrect the token", async () => {
    const listener = createRuntime();
    const socket = new MockSocket();
    initializeMockConnection(listener, socket);
    setActiveRuntime(listener);
    const processed: IncomingMessage[] = [];
    const handleMessage = buildHandler(listener, socket, processed);

    await handleMessage(
      inputFrame({
        client_message_id: "m-1",
        super_run_id: "sr-1",
        mcp_originator_token: "mst_one.secret-a",
      }),
    );
    await waitFor(() => processed.length === 1);
    expect(getMcpOriginatorToken("sr-1")).toBe("mst_one.secret-a");

    // The owning turn finishes: the durable disposition is retired and the
    // finalizer drops the token. A late duplicate re-delivery must not
    // re-insert an orphaned token — the terminal tombstone is not a live
    // owner even though the disposition entry itself persists.
    const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
    const identity = ordinaryInputIdentity("m-1");
    completeInputReplay(runtime, identity ? [identity] : []);
    deleteMcpOriginatorToken("sr-1");
    await handleMessage(
      inputFrame(
        {
          client_message_id: "m-1",
          super_run_id: "sr-1",
          mcp_originator_token: "mst_one.secret-b",
        },
        "req-2",
      ),
    );
    // Give the duplicate path a chance to (wrongly) record.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(getMcpOriginatorToken("sr-1")).toBeUndefined();
    expect(mcpOriginatorTokenCount()).toBe(0);
    expect(processed.length).toBe(1);
  });

  test("stays inert when the delivery carries no token", async () => {
    const listener = createRuntime();
    const socket = new MockSocket();
    initializeMockConnection(listener, socket);
    setActiveRuntime(listener);
    const processed: IncomingMessage[] = [];
    const handleMessage = buildHandler(listener, socket, processed);

    await handleMessage(inputFrame({}));

    await waitFor(() => processed.length === 1);
    expect(processed[0]?.mcpOriginatorSuperRunId).toBeUndefined();
    expect(mcpOriginatorTokenCount()).toBe(0);
  });

  test("ignores a token delivered without its super run id", async () => {
    const listener = createRuntime();
    const socket = new MockSocket();
    initializeMockConnection(listener, socket);
    setActiveRuntime(listener);
    const processed: IncomingMessage[] = [];
    const handleMessage = buildHandler(listener, socket, processed);

    await handleMessage(
      inputFrame({ mcp_originator_token: "mst_one.secret-a" }),
    );

    await waitFor(() => processed.length === 1);
    expect(processed[0]?.mcpOriginatorSuperRunId).toBeUndefined();
    expect(mcpOriginatorTokenCount()).toBe(0);
  });

  test("an unattributed super run id rides along without a stored token", async () => {
    const listener = createRuntime();
    const socket = new MockSocket();
    initializeMockConnection(listener, socket);
    setActiveRuntime(listener);
    const processed: IncomingMessage[] = [];
    const handleMessage = buildHandler(listener, socket, processed);

    await handleMessage(inputFrame({ super_run_id: "sr-2" }));

    await waitFor(() => processed.length === 1);
    expect(processed[0]?.mcpOriginatorSuperRunId).toBe("sr-2");
    expect(mcpOriginatorTokenCount()).toBe(0);
  });

  test("a tokenless redelivery clears the run's previously held token", async () => {
    // The relay re-mints per delivery and revokes the prior token, so a
    // tokenless frame for the same run is authoritative about the run now
    // having no listener-side authority (evil-shub r4300499673).
    const listener = createRuntime();
    const socket = new MockSocket();
    initializeMockConnection(listener, socket);
    setActiveRuntime(listener);
    const processed: IncomingMessage[] = [];
    const handleMessage = buildHandler(listener, socket, processed);

    await handleMessage(
      inputFrame({
        client_message_id: "m-1",
        super_run_id: "sr-1",
        mcp_originator_token: "mst_one.secret-a",
      }),
    );
    await waitFor(() => processed.length === 1);
    expect(getMcpOriginatorToken("sr-1")).toBe("mst_one.secret-a");

    await handleMessage(
      inputFrame({ client_message_id: "m-2", super_run_id: "sr-1" }, "req-2"),
    );
    await waitFor(() => processed.length === 2);
    expect(processed[1]?.mcpOriginatorSuperRunId).toBe("sr-1");
    expect(getMcpOriginatorToken("sr-1")).toBeUndefined();
  });
});

describe("MCP originator batch resolution", () => {
  function enqueueMessage(
    runtime: ReturnType<typeof getOrCreateScopedRuntime>,
    content: string,
    mcpOriginatorSuperRunId?: string,
    mcpOriginatorTokenPresent?: boolean,
    preserveExisting = false,
  ): void {
    enqueueInboundUserMessage(
      runtime,
      {
        type: "message",
        agentId: "agent-1",
        conversationId: "conv-1",
        actingUserId: "same-actor",
        ...(mcpOriginatorSuperRunId ? { mcpOriginatorSuperRunId } : {}),
        ...(mcpOriginatorSuperRunId
          ? { mcpOriginatorTokenPresent: Boolean(mcpOriginatorTokenPresent) }
          : {}),
        messages: [{ role: "user", content }],
      },
      "same-actor",
      { preserveExisting },
    );
  }

  test("an originator-unanimous batch keeps its super run id", () => {
    const runtime = getOrCreateScopedRuntime(
      createRuntime(),
      "agent-1",
      "conv-1",
    );
    enqueueMessage(runtime, "first", "sr-1");
    enqueueMessage(runtime, "second", "sr-1");

    const consumed = consumeQueuedTurn(runtime);
    expect(consumed?.queuedTurn.mcpOriginatorSuperRunId).toBe("sr-1");
  });

  for (const [firstId, firstPresent, secondId, secondPresent] of [
    ["sr-1", true, "sr-2", true],
    ["sr-1", true, undefined, false],
    [undefined, false, "sr-1", true],
    ["sr-1", false, "sr-1", true],
    ["sr-1", true, "sr-1", false],
  ] as const) {
    test(`partitions FIFO ${firstId}/${firstPresent} then ${secondId}/${secondPresent}`, () => {
      const runtime = getOrCreateScopedRuntime(
        createRuntime(),
        "agent-1",
        "conv-1",
      );
      setMcpOriginatorToken("sr-1", "mst_one.secret-a");
      setMcpOriginatorToken("sr-2", "mst_two.secret-b");
      enqueueMessage(runtime, "first", firstId, firstPresent);
      enqueueMessage(runtime, "second", secondId, secondPresent);
      const consumed = consumeQueuedTurn(runtime);
      expect(consumed?.queuedTurn.mcpOriginatorSuperRunId).toBe(firstId);
      expect(consumed?.queuedTurn.messages).toHaveLength(1);
      expect(runtime.queueRuntime.readyLength).toBe(1);
      expect(getMcpOriginatorToken("sr-2")).toBe("mst_two.secret-b");
      expect(getMcpOriginatorToken("sr-1")).toBe("mst_one.secret-a");
      expect(
        consumeQueuedTurn(runtime)?.queuedTurn.mcpOriginatorSuperRunId,
      ).toBe(secondId);
    });
  }

  for (const kind of [
    "cron_prompt",
    "task_notification",
    "mod_continue",
  ] as const) {
    for (const processFirst of [true, false]) {
      test(`${kind} partitions from attributed work, processFirst=${processFirst}`, () => {
        const runtime = getOrCreateScopedRuntime(
          createRuntime(),
          "agent-1",
          "conv-1",
        );
        function enqueueProcess() {
          runtime.queueRuntime.enqueue({
            kind,
            source: kind,
            text: "process work",
            content: [{ type: "text", text: "process work" }],
            agentId: "agent-1",
            conversationId: "conv-1",
          } as Parameters<typeof runtime.queueRuntime.enqueue>[0]);
        }
        if (processFirst) enqueueProcess();
        enqueueMessage(runtime, "A", "sr-1", true);
        if (!processFirst) enqueueProcess();
        const first = consumeQueuedTurn(runtime);
        expect(first?.queuedTurn.messages).toHaveLength(1);
        expect(first?.queuedTurn.mcpOriginatorSuperRunId).toBe(
          processFirst ? undefined : "sr-1",
        );
        expect(first?.queuedTurn.processOwnedTurn === true).toBe(processFirst);
        const second = consumeQueuedTurn(runtime);
        expect(second?.queuedTurn.messages).toHaveLength(1);
        expect(second?.queuedTurn.processOwnedTurn === true).toBe(
          !processFirst,
        );
        expect(runtime.queueRuntime.length).toBe(0);
      });
    }
  }

  test("missing stored payload is unattributed, even with the same actor", () => {
    const runtime = getOrCreateScopedRuntime(
      createRuntime(),
      "agent-1",
      "conv-1",
    );
    enqueueMessage(runtime, "missing", "sr-1", true);
    const missing = runtime.queueRuntime.peekReady()[0];
    if (!missing) throw new Error("Missing queue item");
    runtime.queuedMessagesByItemId.delete(missing.id);
    enqueueMessage(runtime, "A", "sr-1", true);
    expect(
      consumeQueuedTurn(runtime, null)?.queuedTurn.mcpOriginatorSuperRunId,
    ).toBeUndefined();
    expect(runtime.queueRuntime.length).toBe(1);
    expect(consumeQueuedTurn(runtime, null)).toBeNull();
    expect(runtime.queueRuntime.length).toBe(1);
    expect(consumeQueuedTurn(runtime)?.queuedTurn.mcpOriginatorSuperRunId).toBe(
      "sr-1",
    );
  });

  test("prefix counts READY items while preserving a paused incompatible item", () => {
    const runtime = getOrCreateScopedRuntime(
      createRuntime(),
      "agent-1",
      "conv-1",
    );
    enqueueMessage(runtime, "paused B", "sr-2", true);
    runtime.queueRuntime.pause();
    enqueueMessage(runtime, "A first", "sr-1", true, true);
    enqueueMessage(runtime, "A second", "sr-1", true, true);
    enqueueMessage(runtime, "ready B", "sr-2", true, true);
    expect(consumeQueuedTurn(runtime)?.queuedTurn.messages).toHaveLength(2);
    expect(runtime.queueRuntime.length).toBe(2);
    expect(runtime.queueRuntime.pausedCount).toBe(1);
    expect(runtime.queuedMessagesByItemId.size).toBe(2);
    expect(consumeQueuedTurn(runtime)?.queuedTurn.messages).toHaveLength(1);
    runtime.queueRuntime.resume();
    expect(consumeQueuedTurn(runtime)?.queuedTurn.messages).toHaveLength(1);
  });

  test("active constraint cannot skip B to reach A or mutate ownership maps", () => {
    const runtime = getOrCreateScopedRuntime(
      createRuntime(),
      "agent-1",
      "conv-1",
    );
    enqueueMessage(runtime, "B", "sr-2", true);
    enqueueMessage(runtime, "A", "sr-1", true);
    const before = runtime.queueRuntime.peekReady();
    expect(
      consumeQueuedTurn(
        runtime,
        getMcpOriginatorScope({
          mcpOriginatorSuperRunId: "sr-1",
          mcpOriginatorTokenPresent: true,
        }),
      ),
    ).toBeNull();
    expect(runtime.queueRuntime.peekReady()).toEqual(before);
    expect(runtime.queuedMessagesByItemId.size).toBe(2);
    expect(runtime.dequeuedInputIdentitiesByBatchId.size).toBe(0);
    expect(runtime.dequeuedClientMessageIdsByBatchId.size).toBe(0);
  });

  test("an id-unanimous batch with uniform token presence stays attributed", () => {
    const runtime = getOrCreateScopedRuntime(
      createRuntime(),
      "agent-1",
      "conv-1",
    );
    enqueueMessage(runtime, "first", "sr-1", true);
    enqueueMessage(runtime, "second", "sr-1", true);

    const consumed = consumeQueuedTurn(runtime);
    expect(consumed?.queuedTurn.mcpOriginatorSuperRunId).toBe("sr-1");
    expect(consumed?.queuedTurn.messages).toHaveLength(2);
  });

  test("an originator-unanimous batch keeps its run's held token", () => {
    const runtime = getOrCreateScopedRuntime(
      createRuntime(),
      "agent-1",
      "conv-1",
    );
    setMcpOriginatorToken("sr-1", "mst_one.secret-a");
    enqueueMessage(runtime, "first", "sr-1");
    enqueueMessage(runtime, "second", "sr-1");

    const consumed = consumeQueuedTurn(runtime);
    expect(consumed?.queuedTurn.mcpOriginatorSuperRunId).toBe("sr-1");
    expect(getMcpOriginatorToken("sr-1")).toBe("mst_one.secret-a");
  });
});

describe("MCP originator token lifecycle", () => {
  function buildFinalizer(mcpOriginatorSuperRunId: string) {
    const listener = createRuntime();
    const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
    const lease = runtime.turnLifecycle.begin({
      origin: "message",
      workingDirectory: process.cwd(),
    });
    const transport: ListenerTransport = {
      kind: "local",
      bufferedAmount: 0,
      isOpen: () => true,
      send: () => {},
    };
    const incoming: IncomingMessage = {
      type: "message",
      agentId: "agent-1",
      conversationId: "conv-1",
      mcpOriginatorSuperRunId,
      messages: [{ role: "user", content: "hello" }],
    };
    const finalizer = createTurnFinalizer({
      runtime,
      turnLease: lease,
      socket: transport,
      ownership: createTurnDurabilityOwnership(),
      turnCorrelation: createTurnCorrelation(runtime, incoming, "batch-1"),
      buffers: createBuffers(),
      agentId: "agent-1",
      conversationId: "conv-1",
      mcpOriginatorSuperRunId,
    });
    return { finalizer, lease, runtime };
  }

  test("a terminal turn drops its run's held token", () => {
    setMcpOriginatorToken("sr-1", "mst_one.secret-a");
    setMcpOriginatorToken("sr-2", "mst_two.secret-b");
    const { finalizer } = buildFinalizer("sr-1");

    const transition = finalizer.finishTurn({
      stopReason: "end_turn",
      conversationId: "conv-1",
    });

    expect(transition.finished).toBe(true);
    expect(getMcpOriginatorToken("sr-1")).toBeUndefined();
    // Other runs' tokens are untouched.
    expect(getMcpOriginatorToken("sr-2")).toBe("mst_two.secret-b");
  });

  test("a rejected terminal commit keeps the held token", () => {
    setMcpOriginatorToken("sr-1", "mst_one.secret-a");
    const { finalizer } = buildFinalizer("sr-1");
    // A fenced-out (stale owner) commit must not retire the run's token.
    const transition = finalizer.finishTurn({
      stopReason: "end_turn",
      conversationId: "conv-1",
      canCommit: () => false,
    });

    expect(transition.finished).toBe(false);
    expect(getMcpOriginatorToken("sr-1")).toBe("mst_one.secret-a");
  });
});
