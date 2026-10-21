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
  ): void {
    enqueueInboundUserMessage(runtime, {
      type: "message",
      agentId: "agent-1",
      conversationId: "conv-1",
      ...(mcpOriginatorSuperRunId ? { mcpOriginatorSuperRunId } : {}),
      ...(mcpOriginatorSuperRunId
        ? { mcpOriginatorTokenPresent: Boolean(mcpOriginatorTokenPresent) }
        : {}),
      messages: [{ role: "user", content }],
    });
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

  test("a mixed-originator batch runs unattributed", () => {
    const runtime = getOrCreateScopedRuntime(
      createRuntime(),
      "agent-1",
      "conv-1",
    );
    enqueueMessage(runtime, "first", "sr-1");
    enqueueMessage(runtime, "second", "sr-2");

    const consumed = consumeQueuedTurn(runtime);
    expect(consumed?.queuedTurn.mcpOriginatorSuperRunId).toBeUndefined();
  });

  test("an unattributed member never borrows the batch's originator", () => {
    const runtime = getOrCreateScopedRuntime(
      createRuntime(),
      "agent-1",
      "conv-1",
    );
    // The attributed message arrives first and becomes the template; its id
    // must not leak into the merged turn through the template spread.
    enqueueMessage(runtime, "first", "sr-1");
    enqueueMessage(runtime, "second");

    const consumed = consumeQueuedTurn(runtime);
    expect(consumed?.queuedTurn.mcpOriginatorSuperRunId).toBeUndefined();
  });

  test("a non-message batch member votes unattributed", () => {
    // Cron prompts, task notifications, and mod continuations carry no
    // originator delivery; merging one with an attributed message must not
    // let process-owned work ride the user's token (evil-shub r4300499679).
    const runtime = getOrCreateScopedRuntime(
      createRuntime(),
      "agent-1",
      "conv-1",
    );
    enqueueMessage(runtime, "user follow-up", "sr-1");
    runtime.queueRuntime.enqueue({
      kind: "task_notification",
      source: "task_notification",
      text: "subagent finished",
      content: [{ type: "text", text: "subagent finished" }],
      agentId: "agent-1",
      conversationId: "conv-1",
    } as Parameters<typeof runtime.queueRuntime.enqueue>[0]);

    const consumed = consumeQueuedTurn(runtime);
    expect(consumed?.queuedTurn.mcpOriginatorSuperRunId).toBeUndefined();
    expect(consumed?.queuedTurn.messages.length).toBe(2);
  });

  test("a mixed batch retires its constituents' held tokens", () => {
    // The merged turn is unattributed and consumes every constituent input,
    // so no later turn can legitimately use their tokens; they are dropped
    // at merge time instead of leaking until session teardown (evil-shub
    // r4300499690).
    const runtime = getOrCreateScopedRuntime(
      createRuntime(),
      "agent-1",
      "conv-1",
    );
    setMcpOriginatorToken("sr-1", "mst_one.secret-a");
    setMcpOriginatorToken("sr-2", "mst_two.secret-b");
    setMcpOriginatorToken("sr-unrelated", "mst_three.secret-c");
    enqueueMessage(runtime, "first", "sr-1");
    enqueueMessage(runtime, "second", "sr-2");

    const consumed = consumeQueuedTurn(runtime);
    expect(consumed?.queuedTurn.mcpOriginatorSuperRunId).toBeUndefined();
    expect(getMcpOriginatorToken("sr-1")).toBeUndefined();
    expect(getMcpOriginatorToken("sr-2")).toBeUndefined();
    expect(getMcpOriginatorToken("sr-unrelated")).toBe("mst_three.secret-c");
  });

  test("token-bearing and tokenless deliveries for the SAME run vote distinct", () => {
    // The merge vote is on (super run id, token presence), not the id alone:
    // the tokenless delivery is a stale pre-mint frame whose accept cleared
    // the run's authority, so merging it with the fresh token-bearing one
    // would let stale work borrow the fresh token (evil-shub r4300657667).
    const runtime = getOrCreateScopedRuntime(
      createRuntime(),
      "agent-1",
      "conv-1",
    );
    setMcpOriginatorToken("sr-1", "mst_one.secret-a");
    enqueueMessage(runtime, "stale pre-mint frame", "sr-1", false);
    enqueueMessage(runtime, "fresh token-bearing frame", "sr-1", true);

    const consumed = consumeQueuedTurn(runtime);
    expect(consumed?.queuedTurn.mcpOriginatorSuperRunId).toBeUndefined();
    // The mixed batch also retires the constituent run's held token.
    expect(getMcpOriginatorToken("sr-1")).toBeUndefined();
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
