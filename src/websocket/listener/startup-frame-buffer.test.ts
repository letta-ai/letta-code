import { afterEach, describe, expect, mock, test } from "bun:test";
import type WebSocket from "ws";
import {
  closeListenerConnection,
  markListenerConnectionInitialized,
  openListenerConnection,
} from "./connection";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { createRuntime } from "./lifecycle";
import { createListenerMessageHandler } from "./message-router";
import { setActiveRuntime } from "./runtime";
import {
  MAX_PENDING_STARTUP_FRAME_BYTES,
  MAX_PENDING_STARTUP_FRAMES,
  StartupFrameBuffer,
} from "./startup-frame-buffer";
import {
  activateStartupIngress,
  claimRequestlessStartupFrameHandoff,
  handoffRequestlessStartupFrames,
  reserveStartupIngressOwner,
} from "./startup-ingress";
import type { IncomingMessage, StartListenerOptions } from "./types";

afterEach(() => setActiveRuntime(null));

describe("startup frame buffering", () => {
  test("drains arrivals accepted during startup in strict FIFO order", async () => {
    const buffer = new StartupFrameBuffer();
    const handled: string[] = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const handle = async (frame: import("ws").RawData): Promise<void> => {
      handled.push(frame.toString());
      if (frame.toString() === "first") await firstBlocked;
    };
    buffer.accept(Buffer.from("first"), handle);
    buffer.accept(Buffer.from("second"), handle);
    const activation = buffer.drainToLive(handle, () => true);
    await Promise.resolve();
    buffer.accept(Buffer.from("third"), handle);
    expect(handled).toEqual(["first"]);
    expect(buffer.phase).toBe("draining");

    releaseFirst();
    await expect(activation).resolves.toBe(true);
    expect(handled).toEqual(["first", "second", "third"]);
    expect(buffer.phase).toBe("live");
  });

  test("does not apply startup limits after the pump is live", async () => {
    const terminate = mock(() => {});
    const buffer = StartupFrameBuffer.forSockets(
      { terminate },
      () => null,
      mock(() => {}),
    );
    const handled = mock(async () => {});
    await expect(buffer.drainToLive(handled, () => true)).resolves.toBe(true);
    for (let index = 0; index < MAX_PENDING_STARTUP_FRAMES * 2; index += 1) {
      buffer.accept(Buffer.alloc(8_192), handled);
    }
    expect(buffer.phase).toBe("live");
    expect(terminate).not.toHaveBeenCalled();
    expect(handled).toHaveBeenCalledTimes(MAX_PENDING_STARTUP_FRAMES * 2);
  });

  test("terminates the dynamically attached stream exactly once", () => {
    const controlTerminate = mock(() => {});
    const streamTerminate = mock(() => {});
    const report = mock(() => {});
    let streamSocket: { terminate: () => void } | null = null;
    const buffer = StartupFrameBuffer.forSockets(
      { terminate: controlTerminate },
      () => streamSocket,
      report,
    );
    streamSocket = { terminate: streamTerminate };

    for (let index = 0; index <= MAX_PENDING_STARTUP_FRAMES; index += 1) {
      buffer.accept(Buffer.from("frame"), async () => {});
    }
    buffer.accept(Buffer.from("later"), async () => {});

    expect(controlTerminate).toHaveBeenCalledTimes(1);
    expect(streamTerminate).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledTimes(1);
    expect(buffer.drain()).toEqual([]);
  });

  test("hands requestless input only to its explicit replacement lineage", async () => {
    const runtime = createRuntime();
    const socket = {
      kind: "local" as const,
      bufferedAmount: 0,
      isOpen: () => true,
      send: () => {},
    };
    const optionsFor = (
      connectionId: string,
      connectionIdCanResume = true,
    ): StartListenerOptions => ({
      connectionId,
      wsUrl: "local://test",
      deviceId: "device",
      connectionName: "test",
      connectionIdCanResume,
      onConnected: () => {},
      onDisconnected: () => {},
      onError: () => {},
    });
    const staleConnection = openListenerConnection({
      runtime,
      connectionId: "connection-a",
      writer: socket,
      options: optionsFor("connection-a"),
    });
    const legacyFrame = Buffer.from(
      JSON.stringify({
        type: "message",
        agentId: "agent-1",
        conversationId: "conversation-1",
        messages: [{ role: "user", content: "legacy pre-ready" }],
      }),
    );
    const requestlessV2Frame = Buffer.from(
      JSON.stringify({
        type: "input",
        runtime: {
          agent_id: "agent-1",
          conversation_id: "conversation-1",
        },
        payload: {
          kind: "create_message",
          messages: [{ role: "user", content: "v2 pre-ready" }],
        },
      }),
    );
    const ackCapableFrame = Buffer.from(
      JSON.stringify({
        type: "input",
        request_id: "request-a",
        runtime: {
          agent_id: "agent-1",
          conversation_id: "conversation-1",
        },
        payload: {
          kind: "create_message",
          messages: [{ role: "user", content: "must fail closed" }],
        },
      }),
    );
    const staleBuffer = new StartupFrameBuffer();
    for (const frame of [legacyFrame, requestlessV2Frame, ackCapableFrame]) {
      staleBuffer.accept(frame, async () => {
        throw new Error("stale connection processed input");
      });
    }
    handoffRequestlessStartupFrames(
      runtime,
      staleConnection.startupOwner,
      staleBuffer,
    );
    staleBuffer.abort();
    closeListenerConnection(runtime, staleConnection.id);

    // App Server may have unrelated B/C connections starting concurrently. They
    // cannot claim A's requestless input or its output/approval ownership.
    for (const connectionId of ["connection-b", "connection-c"]) {
      const unrelated = openListenerConnection({
        runtime,
        connectionId,
        writer: socket,
        options: optionsFor(connectionId, false),
      });
      expect(
        claimRequestlessStartupFrameHandoff(runtime, unrelated.startupOwner)
          .handoff,
      ).toEqual({ kind: "frames", frames: [], byteLength: 0 });
      closeListenerConnection(runtime, unrelated.id);
      expect(runtime.startupGenerationByLineage.has(connectionId)).toBe(false);
    }

    const options = optionsFor("connection-a");
    const replacement = openListenerConnection({
      runtime,
      connectionId: options.connectionId,
      writer: socket,
      options,
    });
    markListenerConnectionInitialized(runtime, replacement.id, replacement);
    setActiveRuntime(runtime);
    const executeTurn = mock(async (_incoming: IncomingMessage) => {});
    const dispatchedRuntime = getOrCreateScopedRuntime(
      runtime,
      "agent-1",
      "conversation-1",
    );
    const handleReplacementMessage = createListenerMessageHandler({
      runtime,
      socket: socket as unknown as WebSocket,
      connectionId: replacement.id,
      opts: options,
      processQueuedTurn: async () => {},
      fileCommandSession: { handle: () => false },
      getParsedRuntimeScope: () => null,
      replaySyncStateForRuntime: async () => {},
      getOrCreateScopedRuntime: () => dispatchedRuntime,
      handleApprovalResponseInput: async () => false,
      handleChangeDeviceStateInput: async () => false,
      handleAbortMessageInput: async () => false,
      stampInboundUserMessageOtids: (incoming) => incoming,
      safeSocketSend: () => true,
      runDetachedListenerTask: () => {},
      trackListenerError: () => {},
      processIncomingMessage: executeTurn,
    });
    await expect(
      activateStartupIngress(
        new StartupFrameBuffer(),
        handleReplacementMessage,
        () => true,
        () =>
          claimRequestlessStartupFrameHandoff(
            runtime,
            replacement.startupOwner,
          ),
      )(),
    ).resolves.toBe(true);
    await dispatchedRuntime.messageQueue;

    expect(executeTurn).toHaveBeenCalledTimes(2);
    expect(
      claimRequestlessStartupFrameHandoff(runtime, replacement.startupOwner)
        .handoff,
    ).toEqual({ kind: "frames", frames: [], byteLength: 0 });
  });

  test("hands off frames buffered before a connection exists exactly once", async () => {
    const runtime = createRuntime();
    const socket = {
      kind: "local" as const,
      bufferedAmount: 0,
      isOpen: () => true,
      send: () => {},
    };
    const options: StartListenerOptions = {
      connectionId: "connection-a",
      wsUrl: "local://test",
      deviceId: "device",
      connectionName: "test",
      onConnected: () => {},
      onDisconnected: () => {},
      onError: () => {},
    };
    const frameFor = (payload: Record<string, unknown>) =>
      Buffer.from(JSON.stringify(payload));
    const legacyFrame = frameFor({
      type: "message",
      agentId: "agent-1",
      conversationId: "conversation-1",
      messages: [{ role: "user", content: "legacy pre-ready" }],
    });
    const requestlessV2Frame = frameFor({
      type: "input",
      runtime: { agent_id: "agent-1", conversation_id: "conversation-1" },
      payload: {
        kind: "create_message",
        messages: [{ role: "user", content: "v2 pre-ready" }],
      },
    });
    const ackCapableFrame = frameFor({
      type: "input",
      request_id: "request-a",
      runtime: { agent_id: "agent-1", conversation_id: "conversation-1" },
      payload: {
        kind: "create_message",
        messages: [{ role: "user", content: "must fail closed" }],
      },
    });

    // The control socket is already buffering while the stream channel is
    // being prepared, so no ListenerConnectionState exists yet.
    const owner = reserveStartupIngressOwner(runtime, options);
    const buffer = new StartupFrameBuffer();
    for (const frame of [legacyFrame, requestlessV2Frame, ackCapableFrame]) {
      buffer.accept(frame, async () => {
        throw new Error("pre-ready frame executed on a dying attempt");
      });
    }

    // The attempt dies in that window. Both the open-handler catch and the
    // socket close handler abort the same ingress; the frames must be parked
    // once, not twice and not never.
    expect(handoffRequestlessStartupFrames(runtime, owner, buffer)).toBe(true);
    buffer.abort();
    expect(handoffRequestlessStartupFrames(runtime, owner, buffer)).toBe(false);

    const nextOwner = reserveStartupIngressOwner(runtime, options);
    const connection = openListenerConnection({
      runtime,
      connectionId: options.connectionId,
      writer: socket,
      options,
      startupOwner: nextOwner,
    });
    expect(connection.startupOwner).toBe(nextOwner);

    const claim = claimRequestlessStartupFrameHandoff(
      runtime,
      connection.startupOwner,
    );
    expect(claim.handoff.kind).toBe("frames");
    if (claim.handoff.kind !== "frames") {
      throw new Error("Expected frame handoff");
    }
    expect(claim.handoff.frames.map((frame) => frame.toString())).toEqual([
      legacyFrame.toString(),
      requestlessV2Frame.toString(),
    ]);
    // Claiming is non-destructive until the successor accepts the payload.
    expect(runtime.pendingStartupFramesByLineage.has(owner.lineageId)).toBe(
      true,
    );
    claim.commit();
    expect(
      claimRequestlessStartupFrameHandoff(runtime, connection.startupOwner)
        .handoff,
    ).toEqual({ kind: "frames", frames: [], byteLength: 0 });
    closeListenerConnection(runtime, connection.id);
  });

  test("terminates when one frame exceeds the byte limit", () => {
    const terminate = mock(() => {});
    const report = mock(() => {});
    const buffer = StartupFrameBuffer.forSockets(
      { terminate },
      () => null,
      report,
    );

    buffer.accept(
      Buffer.alloc(MAX_PENDING_STARTUP_FRAME_BYTES + 1),
      async () => {},
    );

    expect(terminate).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledTimes(1);
    expect(buffer.drain()).toEqual([]);
  });
});
