import { afterEach, describe, expect, mock, test } from "bun:test";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import {
  clearExternalTools,
  prepareToolExecutionContextForModel,
  prepareToolExecutionContextForSpecificTools,
  releaseToolExecutionContext,
} from "@/tools/manager";
import { CHANNEL_SERVICE_COMMAND_TYPES } from "@/types/service-protocol";
import {
  markListenerConnectionInitialized,
  openListenerConnection,
  subscribeListenerConnection,
  suspendListenerConnection,
} from "./connection";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { enqueueInboundUserMessage } from "./inbound-queue";
import { createRuntime, safeSocketSend } from "./lifecycle";
import { createListenerMessageHandler } from "./message-router";
import { scheduleQueuePump } from "./queue";
import { setActiveRuntime } from "./runtime";
import { handleApprovalStop } from "./turn-approval";
import { createTurnInputState } from "./turn-input-state";
import type { IncomingMessage, StartListenerOptions } from "./types";

class MockSocket {
  readyState = WebSocket.OPEN;
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

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await Bun.sleep(1);
  }
  throw new Error("Timed out waiting for listener state");
}

describe("listener message router ownership handoff", () => {
  afterEach(() => {
    clearExternalTools();
    setActiveRuntime(null);
  });

  for (const reconnectBeforeApproval of [true, false]) {
    test(`teleport_continue executes once after socket replacement (${reconnectBeforeApproval ? "before approval" : "while approval waits"})`, async () => {
      const listener = createRuntime();
      const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
      const opts = makeListenerOptions();
      const scope = { agent_id: "agent-1", conversation_id: "conv-1" };
      const directory = await mkdtemp(join(tmpdir(), "teleport-reconnect-"));
      const executionFile = join(directory, "executions");
      const permissionModeState = { mode: "unrestricted" as const };
      const context = await prepareToolExecutionContextForSpecificTools(
        ["Bash"],
        { workingDirectory: directory, permissionModeState },
      );
      const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
      await once(server, "listening");
      const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const sockets: WebSocket[] = [];
      const tasks: Promise<void>[] = [];
      const errors: unknown[] = [];
      let releaseModelResponse!: () => void;
      const modelResponse = new Promise<void>((resolve) => {
        releaseModelResponse = resolve;
      });
      let turnStarts = 0;
      let approvalStarted = false;
      let continuationSends = 0;
      let secretsHydrations = 0;
      let finished = false;
      const toolCallId = "call-after-teleport";
      const wireInput = (requestId: string) =>
        JSON.stringify({
          type: "input",
          request_id: requestId,
          runtime: scope,
          payload: {
            kind: "teleport_continue",
            teleport_id: "teleport-reconnect",
            source: { device_id: "source", connection_name: "Source" },
            continuation: {
              approvals: [
                {
                  type: "tool",
                  tool_call_id: "call-on-source",
                  status: "success",
                  tool_return: "source finished",
                },
              ],
            },
          },
        });
      type Frame = {
        type: string;
        request_id?: string;
        accepted?: boolean;
        delta?: {
          id?: string;
          message_type?: string;
          tool_call_id?: string;
          tool_returns?: Array<{ tool_call_id?: string; status?: string }>;
        };
      };
      const connect = async () => {
        const accepted = once(server, "connection");
        const socket = new WebSocket(url);
        sockets.push(socket);
        await once(socket, "open");
        const [peer] = (await accepted) as [WebSocket];
        sockets.push(peer);
        const frames: Frame[] = [];
        peer.on("message", (data) => frames.push(JSON.parse(data.toString())));
        openListenerConnection({
          runtime: listener,
          connectionId: opts.connectionId,
          writer: socket,
          options: opts,
        });
        markListenerConnectionInitialized(listener, opts.connectionId);
        subscribeListenerConnection(listener, opts.connectionId, scope);
        const handler = createListenerMessageHandler({
          runtime: listener,
          socket,
          opts,
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
            tasks.push(
              task().catch((error) => {
                errors.push(error);
              }),
            );
          },
          trackListenerError: (error) => {
            errors.push(error);
          },
          // Model-boundary adapter: preserve the router-supplied transport and
          // pause the resumed model response until the original socket closes.
          // Classification, reconnect polling, tool execution and wire emission
          // below are production implementations, not substituted dependencies.
          processIncomingMessage: async (incoming, transport, conversation) => {
            turnStarts += 1;
            expect(incoming.messages).toEqual([
              expect.objectContaining({ type: "approval" }),
              expect.objectContaining({ role: "system" }),
            ]);
            expect(conversation).toBe(runtime);
            const lease = runtime.turnLifecycle.begin({
              origin: "message",
              workingDirectory: directory,
              initialStatus: "PROCESSING_API_RESPONSE",
            });
            try {
              await modelResponse;
              approvalStarted = true;
              const result = await handleApprovalStop({
                approvals: [
                  {
                    toolCallId,
                    toolName: "Bash",
                    toolArgs: JSON.stringify({
                      description:
                        "Record one harmless regression tool execution",
                      command:
                        "printf 'executed\\n' >> executions; printf 'teleport-tool-output'",
                    }),
                  },
                ],
                runtime,
                socket: transport,
                agentId: "agent-1",
                conversationId: "conv-1",
                turnWorkingDirectory: directory,
                turnPermissionModeState: permissionModeState,
                dequeuedBatchId: "teleport-batch",
                runId: "teleport-run",
                msgRunIds: ["teleport-run"],
                turnInput: createTurnInputState([]),
                pendingNormalizationInterruptedToolCallIds: [],
                turnToolContextId: context.contextId,
                turnLease: lease,
                buildSendOptions: () => ({ streamTokens: true }),
                dependencies: {
                  // Storage/API boundary only: this local tool needs no secrets.
                  ensureSecretsHydrated: async () => {
                    secretsHydrations += 1;
                  },
                  // Model continuation boundary: inspect the actual tool return.
                  sendApprovalContinuation: async (_id, messages) => {
                    continuationSends += 1;
                    expect(messages).toEqual([
                      expect.objectContaining({
                        type: "approval",
                        approvals: [
                          expect.objectContaining({
                            tool_call_id: toolCallId,
                            status: "success",
                            tool_return: [
                              { type: "text", text: "teleport-tool-output" },
                            ],
                          }),
                        ],
                      }),
                    ]);
                    return {
                      kind: "terminal",
                      drainResult: { stopReason: "end_turn", apiDurationMs: 0 },
                    };
                  },
                },
              });
              expect(result.kind).toBe("terminal");
              finished = true;
            } finally {
              runtime.turnLifecycle.finish(lease, "end_turn");
            }
          },
        });
        socket.on("message", (data) => {
          tasks.push(
            handler(data).catch((error) => {
              errors.push(error);
            }),
          );
        });
        return { socket, peer, frames };
      };
      const countToolFrames = (frames: Frame[], kind: string) =>
        frames.filter(
          (frame) =>
            frame.type === "stream_delta" &&
            !frame.delta?.id?.startsWith("synthetic-tool-return-stream-") &&
            frame.delta?.message_type === kind &&
            (frame.delta.tool_call_id === toolCallId ||
              frame.delta.tool_returns?.some(
                (result) => result.tool_call_id === toolCallId,
              )),
        ).length;
      try {
        setActiveRuntime(listener);
        const original = await connect();
        original.peer.send(wireInput("teleport-initial"));
        await waitFor(() => turnStarts === 1);
        expect(errors).toEqual([]);
        await waitFor(() =>
          original.frames.some(
            (frame) => frame.request_id === "teleport-initial",
          ),
        );
        const closed = once(original.socket, "close");
        original.socket.terminate();
        await closed;
        suspendListenerConnection(listener, opts.connectionId);
        expect(original.socket.readyState).toBe(WebSocket.CLOSED);
        expect(runtime.isProcessing).toBe(true);
        if (!reconnectBeforeApproval) {
          releaseModelResponse();
          await waitFor(() => approvalStarted);
          // Longer than two real reconnect-gate polls; no replacement exists.
          await Bun.sleep(150);
          expect(secretsHydrations).toBe(0);
          expect(continuationSends).toBe(0);
          expect(await Bun.file(executionFile).exists()).toBe(false);
          expect(runtime.loopStatus).toBe("PROCESSING_API_RESPONSE");
          expect(finished).toBe(false);
        }
        const replacement = await connect();
        // Replay on the new wire must be acknowledged, not start a second turn.
        replacement.peer.send(wireInput("teleport-retry"));
        await waitFor(() =>
          replacement.frames.some(
            (frame) => frame.request_id === "teleport-retry" && frame.accepted,
          ),
        );
        releaseModelResponse();
        // A raw closed WebSocket can never reopen, even though a replacement is
        // registered. On the buggy producer this deadline fails, not a mock call.
        for (
          let attempt = 0;
          attempt < 200 && !finished && errors.length === 0;
          attempt += 1
        ) {
          await Bun.sleep(10);
        }
        expect(errors).toEqual([]);
        expect(finished).toBe(true);
        await waitFor(
          () =>
            countToolFrames(replacement.frames, "tool_return_message") === 1,
        );
        replacement.peer.send(wireInput("teleport-retry-finished"));
        await waitFor(() =>
          replacement.frames.some(
            (frame) =>
              frame.request_id === "teleport-retry-finished" && frame.accepted,
          ),
        );
        expect(turnStarts).toBe(1);
        expect(secretsHydrations).toBe(1);
        expect(continuationSends).toBe(1);
        expect(await readFile(executionFile, "utf8")).toBe("executed\n");
        for (const kind of [
          "client_tool_start",
          "client_tool_end",
          "tool_return_message",
        ]) {
          expect(countToolFrames(original.frames, kind)).toBe(0);
          expect(countToolFrames(replacement.frames, kind)).toBe(1);
        }
      } finally {
        releaseModelResponse();
        runtime.turnLifecycle.requestCancellation();
        await Promise.all(tasks);
        for (const socket of sockets) socket.terminate();
        server.close();
        releaseToolExecutionContext(context.contextId);
        await rm(directory, { recursive: true, force: true });
      }
    });
  }

  test("acknowledges batched external-tool registration without runtime startup", async () => {
    const listener = createRuntime();
    const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
    const socket = new MockSocket();
    const sent: unknown[] = [];
    const onLog = mock(() => {});
    setActiveRuntime(listener);
    const handleMessage = createListenerMessageHandler({
      runtime: listener,
      socket: socket as unknown as WebSocket,
      opts: { ...makeListenerOptions(), onLog },
      processQueuedTurn: async () => {},
      fileCommandSession: { handle: () => false },
      getParsedRuntimeScope: () => null,
      replaySyncStateForRuntime: async () => {},
      getOrCreateScopedRuntime: () => runtime,
      handleApprovalResponseInput: async () => false,
      handleChangeDeviceStateInput: async () => false,
      handleAbortMessageInput: async () => false,
      stampInboundUserMessageOtids: (incoming) => incoming,
      safeSocketSend: (_target, payload) => {
        sent.push(payload);
        return true;
      },
      runDetachedListenerTask: () => {},
      trackListenerError: () => {},
      processIncomingMessage: async () => {},
    });

    await handleMessage(
      Buffer.from(
        JSON.stringify({
          type: "runtime_external_tools_update",
          request_id: "tools-1",
          updates: [
            {
              runtimes: [{ agent_id: "agent-1", conversation_id: "conv-1" }],
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
        }),
      ),
    );

    expect(sent).toEqual([
      {
        type: "runtime_external_tools_update_response",
        request_id: "tools-1",
        success: true,
      },
    ]);
    expect(onLog).toHaveBeenCalledWith(
      "[Listen V2] Received runtime_external_tools_update command (request_id=tools-1, updates=1, runtimes=1)",
    );
    const prepared = await prepareToolExecutionContextForModel(
      "anthropic/claude-sonnet-4",
      {
        clientToolAllowlist: ["MessageChannel"],
        runtimeContext: {
          agentId: "agent-1",
          conversationId: "conv-1",
        },
      },
    );
    expect(prepared.clientTools.map((tool) => tool.name)).toEqual([
      "MessageChannel",
    ]);
  });

  test("a direct message that loses the idle race is queued and later drained", async () => {
    const listener = createRuntime();
    const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
    const socket = new MockSocket();
    const opts = makeListenerOptions();
    const processIncomingMessage = mock(async () => {});
    const processedTurns: IncomingMessage[] = [];
    const processQueuedTurn = mock(async (queuedTurn: IncomingMessage) => {
      processedTurns.push(queuedTurn);
    });
    const trackListenerError = mock(() => {});
    const sent: unknown[] = [];
    let releaseMessageQueue!: () => void;
    runtime.messageQueue = new Promise<void>((resolve) => {
      releaseMessageQueue = resolve;
    });
    setActiveRuntime(listener);

    const handleMessage = createListenerMessageHandler({
      runtime: listener,
      socket: socket as unknown as WebSocket,
      opts,
      processQueuedTurn,
      fileCommandSession: { handle: () => false },
      getParsedRuntimeScope: () => null,
      replaySyncStateForRuntime: async () => {},
      getOrCreateScopedRuntime: () => runtime,
      handleApprovalResponseInput: async () => false,
      handleChangeDeviceStateInput: async () => false,
      handleAbortMessageInput: async () => false,
      stampInboundUserMessageOtids: (incoming) => incoming,
      safeSocketSend: (_target, payload) => {
        sent.push(payload);
        return true;
      },
      runDetachedListenerTask: () => {},
      trackListenerError,
      processIncomingMessage,
    });

    await handleMessage(
      Buffer.from(
        JSON.stringify({
          type: "input",
          request_id: "input-race",
          runtime: { agent_id: "agent-1", conversation_id: "conv-1" },
          payload: {
            kind: "create_message",
            messages: [
              {
                role: "user",
                content: "do not drop me",
                client_message_id: "cm-input-race",
              },
            ],
          },
        }),
      ),
    );
    await handleMessage(
      Buffer.from(
        JSON.stringify({
          type: "input",
          request_id: "input-race-retry",
          runtime: { agent_id: "agent-1", conversation_id: "conv-1" },
          payload: {
            kind: "create_message",
            messages: [
              {
                role: "user",
                content: "do not drop me",
                client_message_id: "cm-input-race",
              },
            ],
          },
        }),
      ),
    );
    const recoveryLease = runtime.turnLifecycle.begin({
      origin: "approval_recovery",
      workingDirectory: process.cwd(),
    });

    releaseMessageQueue();
    await runtime.messageQueue;
    await waitFor(
      () => !runtime.queuePumpActive && !runtime.queuePumpScheduled,
    );

    expect(processIncomingMessage).not.toHaveBeenCalled();
    expect(trackListenerError).not.toHaveBeenCalled();
    expect(runtime.queueRuntime.length).toBe(1);
    expect(runtime.queuedMessagesByItemId.size).toBe(1);

    runtime.turnLifecycle.finish(recoveryLease, "end_turn");
    scheduleQueuePump(
      runtime,
      socket as unknown as WebSocket,
      opts,
      processQueuedTurn,
    );
    await waitFor(
      () => processedTurns.length === 1 && runtime.queueRuntime.length === 0,
    );

    expect(processedTurns[0]?.messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "do not drop me" }],
        client_message_id: "cm-input-race",
      },
    ]);
    expect(runtime.queuedMessagesByItemId.size).toBe(0);
    expect(sent).toContainEqual(
      expect.objectContaining({
        type: "input_accepted",
        request_id: "input-race",
        accepted: true,
        disposition: "queued",
      }),
    );
    expect(sent).toContainEqual(
      expect.objectContaining({
        type: "input_accepted",
        request_id: "input-race-retry",
        accepted: true,
        disposition: "queued",
      }),
    );
  });

  test("preserves the acting user on a directly-owned input and deduplicates retries", async () => {
    const listener = createRuntime();
    const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
    const socket = new MockSocket();
    const sent: unknown[] = [];
    let receivedActingUserId: string | undefined;
    const processIncomingMessage = mock(async (incoming: IncomingMessage) => {
      receivedActingUserId = incoming.actingUserId;
    });
    setActiveRuntime(listener);
    const handleMessage = createListenerMessageHandler({
      runtime: listener,
      socket: socket as unknown as WebSocket,
      opts: makeListenerOptions(),
      processQueuedTurn: async () => {},
      fileCommandSession: { handle: () => false },
      getParsedRuntimeScope: () => null,
      replaySyncStateForRuntime: async () => {},
      getOrCreateScopedRuntime: () => runtime,
      handleApprovalResponseInput: async () => false,
      handleChangeDeviceStateInput: async () => false,
      handleAbortMessageInput: async () => false,
      stampInboundUserMessageOtids: (incoming) => incoming,
      safeSocketSend: (_target, payload) => {
        sent.push(payload);
        return true;
      },
      runDetachedListenerTask: () => {},
      trackListenerError: () => {},
      processIncomingMessage,
    });

    await handleMessage(
      Buffer.from(
        JSON.stringify({
          type: "input",
          request_id: "input-direct",
          runtime: {
            agent_id: "agent-1",
            conversation_id: "conv-1",
            acting_user_id: "cloud-user-1",
          },
          payload: {
            kind: "create_message",
            messages: [
              {
                role: "user",
                content: "start now",
                client_message_id: "cm-input-direct",
              },
            ],
          },
        }),
      ),
    );
    await runtime.messageQueue;

    await handleMessage(
      Buffer.from(
        JSON.stringify({
          type: "input",
          request_id: "input-direct-retry",
          runtime: {
            agent_id: "agent-1",
            conversation_id: "conv-1",
            acting_user_id: "cloud-user-1",
          },
          payload: {
            kind: "create_message",
            messages: [
              {
                role: "user",
                content: "start now",
                client_message_id: "cm-input-direct",
              },
            ],
          },
        }),
      ),
    );
    await runtime.messageQueue;

    expect(processIncomingMessage).toHaveBeenCalledTimes(1);
    expect(receivedActingUserId).toBe("cloud-user-1");
    expect(sent).toContainEqual(
      expect.objectContaining({
        type: "input_accepted",
        request_id: "input-direct",
        accepted: true,
        disposition: "started",
      }),
    );
    expect(sent).toContainEqual(
      expect.objectContaining({
        type: "input_accepted",
        request_id: "input-direct-retry",
        accepted: true,
        disposition: "started",
      }),
    );
  });

  test("remove_queue_item broadcasts the queue snapshot even when the item is not found", async () => {
    const listener = createRuntime();
    const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
    const socket = new MockSocket();
    listener.socket = socket as unknown as WebSocket;
    const sent: unknown[] = [];
    setActiveRuntime(listener);

    const handleMessage = createListenerMessageHandler({
      runtime: listener,
      socket: socket as unknown as WebSocket,
      opts: makeListenerOptions(),
      processQueuedTurn: async () => {},
      fileCommandSession: { handle: () => false },
      getParsedRuntimeScope: () => null,
      replaySyncStateForRuntime: async () => {},
      getOrCreateScopedRuntime: () => runtime,
      handleApprovalResponseInput: async () => false,
      handleChangeDeviceStateInput: async () => false,
      handleAbortMessageInput: async () => false,
      stampInboundUserMessageOtids: (incoming) => incoming,
      safeSocketSend: (_target, payload) => {
        sent.push(payload);
        return true;
      },
      runDetachedListenerTask: () => {},
      trackListenerError: () => {},
      processIncomingMessage: async () => {},
    });

    // A queued item exists locally, but the removal targets a DIFFERENT id —
    // the stale-consumer case: the requested item already drained into a turn.
    expect(
      enqueueInboundUserMessage(runtime, {
        type: "message",
        agentId: "agent-1",
        conversationId: "conv-1",
        messages: [
          {
            role: "user",
            content: "still queued",
            client_message_id: "cm-still-queued",
          },
        ],
      }),
    ).toBe(true);
    // Flush the enqueue's own scheduled broadcast so the assertion below
    // isolates the removal handler's emit.
    await Promise.resolve();
    socket.sentPayloads.length = 0;

    await handleMessage(
      Buffer.from(
        JSON.stringify({
          type: "remove_queue_item",
          request_id: "remove-missing",
          runtime: { agent_id: "agent-1", conversation_id: "conv-1" },
          item_id: "item-already-drained",
        }),
      ),
    );

    expect(sent).toContainEqual(
      expect.objectContaining({
        type: "remove_queue_item_response",
        request_id: "remove-missing",
        success: false,
        item_id: "item-already-drained",
      }),
    );
    // The authoritative snapshot must still broadcast so a consumer holding
    // a stale queue copy is repaired. (LET-11174)
    const updates = socket.sentPayloads
      .map((payload) => JSON.parse(payload) as { type: string })
      .filter((payload) => payload.type === "update_queue");
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      runtime: { agent_id: "agent-1", conversation_id: "conv-1" },
      queue: [
        expect.objectContaining({ client_message_id: "cm-still-queued" }),
      ],
      removed: [],
    });
    // Local queue state is untouched.
    expect(runtime.queueRuntime.length).toBe(1);
  });

  test("remove_queue_item for an existing item removes it and broadcasts the change", async () => {
    const listener = createRuntime();
    const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
    const socket = new MockSocket();
    listener.socket = socket as unknown as WebSocket;
    const sent: unknown[] = [];
    setActiveRuntime(listener);

    const handleMessage = createListenerMessageHandler({
      runtime: listener,
      socket: socket as unknown as WebSocket,
      opts: makeListenerOptions(),
      processQueuedTurn: async () => {},
      fileCommandSession: { handle: () => false },
      getParsedRuntimeScope: () => null,
      replaySyncStateForRuntime: async () => {},
      getOrCreateScopedRuntime: () => runtime,
      handleApprovalResponseInput: async () => false,
      handleChangeDeviceStateInput: async () => false,
      handleAbortMessageInput: async () => false,
      stampInboundUserMessageOtids: (incoming) => incoming,
      safeSocketSend: (_target, payload) => {
        sent.push(payload);
        return true;
      },
      runDetachedListenerTask: () => {},
      trackListenerError: () => {},
      processIncomingMessage: async () => {},
    });

    expect(
      enqueueInboundUserMessage(runtime, {
        type: "message",
        agentId: "agent-1",
        conversationId: "conv-1",
        messages: [
          {
            role: "user",
            content: "remove me",
            client_message_id: "cm-to-remove",
          },
        ],
      }),
    ).toBe(true);
    const enqueued = runtime.queueRuntime.peek()[0];
    expect(enqueued).toBeDefined();

    await handleMessage(
      Buffer.from(
        JSON.stringify({
          type: "remove_queue_item",
          request_id: "remove-existing",
          runtime: { agent_id: "agent-1", conversation_id: "conv-1" },
          item_id: enqueued?.id,
        }),
      ),
    );
    // The onRemoved callback schedules its own emit on a microtask.
    await Promise.resolve();

    expect(sent).toContainEqual(
      expect.objectContaining({
        type: "remove_queue_item_response",
        request_id: "remove-existing",
        success: true,
        item_id: enqueued?.id,
      }),
    );
    const updates = socket.sentPayloads
      .map(
        (payload) => JSON.parse(payload) as { type: string; queue?: unknown[] },
      )
      .filter((payload) => payload.type === "update_queue");
    expect(updates.length).toBeGreaterThanOrEqual(1);
    // Every broadcast snapshot reflects the post-removal queue.
    for (const update of updates) {
      expect(update.queue).toEqual([]);
    }
    expect(runtime.queueRuntime.length).toBe(0);
  });

  test("resume_queue releases interrupt-parked items and broadcasts paused flags", async () => {
    const listener = createRuntime();
    const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
    const socket = new MockSocket();
    listener.socket = socket as unknown as WebSocket;
    const sent: unknown[] = [];
    const processedTurns: IncomingMessage[] = [];
    setActiveRuntime(listener);

    const handleMessage = createListenerMessageHandler({
      runtime: listener,
      socket: socket as unknown as WebSocket,
      opts: makeListenerOptions(),
      processQueuedTurn: async (incoming) => {
        processedTurns.push(incoming);
      },
      fileCommandSession: { handle: () => false },
      getParsedRuntimeScope: () => null,
      replaySyncStateForRuntime: async () => {},
      getOrCreateScopedRuntime: () => runtime,
      handleApprovalResponseInput: async () => false,
      handleChangeDeviceStateInput: async () => false,
      handleAbortMessageInput: async () => false,
      stampInboundUserMessageOtids: (incoming) => incoming,
      safeSocketSend: (_target, payload) => {
        sent.push(payload);
        return true;
      },
      runDetachedListenerTask: () => {},
      trackListenerError: () => {},
      processIncomingMessage: async () => {},
    });

    expect(
      enqueueInboundUserMessage(runtime, {
        type: "message",
        agentId: "agent-1",
        conversationId: "conv-1",
        messages: [
          { role: "user", content: "parked", client_message_id: "cm-parked" },
        ],
      }),
    ).toBe(true);
    expect(runtime.queueRuntime.pause()).toBe(1);
    await Promise.resolve();
    const snapshots = () =>
      socket.sentPayloads
        .map(
          (payload) =>
            JSON.parse(payload) as {
              type: string;
              queue?: Array<{ paused?: boolean }>;
            },
        )
        .filter((payload) => payload.type === "update_queue");
    expect(snapshots().at(-1)?.queue).toEqual([
      expect.objectContaining({ paused: true }),
    ]);

    await handleMessage(
      Buffer.from(
        JSON.stringify({
          type: "resume_queue",
          request_id: "resume-1",
          runtime: { agent_id: "agent-1", conversation_id: "conv-1" },
        }),
      ),
    );
    await waitFor(() => processedTurns.length === 1);

    expect(sent).toContainEqual(
      expect.objectContaining({
        type: "resume_queue_response",
        request_id: "resume-1",
        resumed: 1,
        success: true,
      }),
    );
    expect(runtime.queueRuntime.length).toBe(0);
    expect(JSON.stringify(processedTurns[0]?.messages)).toContain("parked");
    const lastQueue = snapshots().at(-1)?.queue ?? [];
    expect(lastQueue.some((item) => item.paused)).toBe(false);
  });

  test("delegates registered service commands and returns their protocol messages", async () => {
    const listener = createRuntime();
    const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
    const socket = new MockSocket();
    const opts = makeListenerOptions();
    const response = {
      type: "channel_routes_list_response" as const,
      request_id: "routes-1",
      success: true,
      routes: [],
    };
    const serviceCommandHandler = mock(async () => ({
      kind: "protocol" as const,
      messages: [response],
    }));
    listener.serviceCommandTypes = new Set(CHANNEL_SERVICE_COMMAND_TYPES);
    listener.serviceCommandHandler = serviceCommandHandler;
    const sent: unknown[] = [];
    const detachedTasks: Promise<void>[] = [];
    setActiveRuntime(listener);

    const handleMessage = createListenerMessageHandler({
      runtime: listener,
      socket: socket as unknown as WebSocket,
      opts,
      processQueuedTurn: async () => {},
      fileCommandSession: { handle: () => false },
      getParsedRuntimeScope: () => null,
      replaySyncStateForRuntime: async () => {},
      getOrCreateScopedRuntime: () => runtime,
      handleApprovalResponseInput: async () => false,
      handleChangeDeviceStateInput: async () => false,
      handleAbortMessageInput: async () => false,
      stampInboundUserMessageOtids: (incoming) => incoming,
      safeSocketSend: (_target, payload) => {
        sent.push(payload);
        return true;
      },
      runDetachedListenerTask: (_label, task) => {
        detachedTasks.push(task());
      },
      trackListenerError: () => {},
      processIncomingMessage: async () => {},
    });

    await handleMessage(
      Buffer.from(
        JSON.stringify({
          type: "channel_routes_list",
          request_id: "routes-1",
          channel_id: "telegram",
        }),
      ),
    );
    await Promise.all(detachedTasks);

    expect(serviceCommandHandler).toHaveBeenCalledWith({
      kind: "protocol",
      command: {
        type: "channel_routes_list",
        request_id: "routes-1",
        channel_id: "telegram",
      },
    });
    expect(sent).toEqual([response]);
  });
});
