import { afterEach, describe, expect, mock, test } from "bun:test";
import type WebSocket from "ws";
import {
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
  handoffLegacyStartupFrames,
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

  test("hands a pre-ready legacy message to the exact replacement once", async () => {
    const runtime = createRuntime();
    const socket = {
      kind: "local" as const,
      bufferedAmount: 0,
      isOpen: () => true,
      send: () => {},
    };
    const options: StartListenerOptions = {
      connectionId: "replacement",
      wsUrl: "local://test",
      deviceId: "device",
      connectionName: "test",
      onConnected: () => {},
      onDisconnected: () => {},
      onError: () => {},
    };
    const connection = openListenerConnection({
      runtime,
      connectionId: options.connectionId,
      writer: socket,
      options,
    });
    markListenerConnectionInitialized(runtime, connection.id, connection);
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
      connectionId: connection.id,
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
    const legacyFrame = Buffer.from(
      JSON.stringify({
        type: "message",
        agentId: "agent-1",
        conversationId: "conversation-1",
        messages: [{ role: "user", content: "legacy pre-ready" }],
      }),
    );
    const staleBuffer = new StartupFrameBuffer();
    staleBuffer.accept(legacyFrame, async () => {
      throw new Error("stale connection processed input");
    });

    handoffLegacyStartupFrames(runtime, staleBuffer);
    staleBuffer.abort();
    const replacementBuffer = new StartupFrameBuffer();
    await expect(
      activateStartupIngress(
        replacementBuffer,
        handleReplacementMessage,
        () => true,
        () => runtime.pendingLegacyStartupFrames?.splice(0) ?? [],
      )(),
    ).resolves.toBe(true);
    await dispatchedRuntime.messageQueue;

    expect(executeTurn).toHaveBeenCalledTimes(1);
    expect(runtime.pendingLegacyStartupFrames).toEqual([]);
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
