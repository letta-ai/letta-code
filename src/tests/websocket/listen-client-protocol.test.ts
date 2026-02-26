import { describe, expect, test } from "bun:test";
import WebSocket from "ws";
import type { ControlRequest, ControlResponseBody } from "../../types/protocol";
import {
  __listenClientTestUtils,
  parseServerMessage,
  rejectPendingApprovalResolvers,
  requestApprovalOverWS,
  resolvePendingApprovalResolver,
} from "../../websocket/listen-client";

class MockSocket {
  readyState: number;
  closeCalls = 0;
  removeAllListenersCalls = 0;
  sentPayloads: string[] = [];
  sendImpl: (data: string) => void = (data) => {
    this.sentPayloads.push(data);
  };

  constructor(readyState: number = WebSocket.OPEN) {
    this.readyState = readyState;
  }

  send(data: string): void {
    this.sendImpl(data);
  }

  close(): void {
    this.closeCalls += 1;
  }

  removeAllListeners(): this {
    this.removeAllListenersCalls += 1;
    return this;
  }
}

function makeControlRequest(requestId: string): ControlRequest {
  return {
    type: "control_request",
    request_id: requestId,
    request: {
      subtype: "can_use_tool",
      tool_name: "Write",
      input: {},
      tool_call_id: "call-1",
      permission_suggestions: [],
      blocked_path: null,
    },
  };
}

function makeSuccessResponse(requestId: string): ControlResponseBody {
  return {
    subtype: "success",
    request_id: requestId,
    response: { behavior: "allow" },
  };
}

describe("listen-client parseServerMessage", () => {
  test("parses valid control_response with required fields", () => {
    const parsed = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "control_response",
          response: { subtype: "success", request_id: "perm-1" },
        }),
      ),
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.type).toBe("control_response");
  });

  test("rejects invalid control_response payloads", () => {
    const missingResponse = parseServerMessage(
      Buffer.from(JSON.stringify({ type: "control_response" })),
    );
    expect(missingResponse).toBeNull();

    const missingRequestId = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "control_response",
          response: { subtype: "success" },
        }),
      ),
    );
    expect(missingRequestId).toBeNull();
  });

  test("keeps backward compatibility for message, pong, mode_change", () => {
    const msg = parseServerMessage(
      Buffer.from(JSON.stringify({ type: "message", messages: [] })),
    );
    const pong = parseServerMessage(
      Buffer.from(JSON.stringify({ type: "pong" })),
    );
    const modeChange = parseServerMessage(
      Buffer.from(JSON.stringify({ type: "mode_change", mode: "default" })),
    );
    expect(msg?.type).toBe("message");
    expect(pong?.type).toBe("pong");
    expect(modeChange?.type).toBe("mode_change");
  });
});

describe("listen-client approval resolver wiring", () => {
  test("resolves matching pending resolver", async () => {
    const runtime = __listenClientTestUtils.createRuntime();
    const socket = new MockSocket(WebSocket.OPEN);
    const requestId = "perm-101";

    const pending = requestApprovalOverWS(
      runtime,
      socket as unknown as WebSocket,
      requestId,
      makeControlRequest(requestId),
    );
    expect(runtime.pendingApprovalResolvers.size).toBe(1);

    const resolved = resolvePendingApprovalResolver(
      runtime,
      makeSuccessResponse(requestId),
    );
    expect(resolved).toBe(true);
    await expect(pending).resolves.toMatchObject({
      subtype: "success",
      request_id: requestId,
    });
    expect(runtime.pendingApprovalResolvers.size).toBe(0);
  });

  test("ignores non-matching request_id and keeps pending resolver", async () => {
    const runtime = __listenClientTestUtils.createRuntime();
    const socket = new MockSocket(WebSocket.OPEN);
    const requestId = "perm-201";

    const pending = requestApprovalOverWS(
      runtime,
      socket as unknown as WebSocket,
      requestId,
      makeControlRequest(requestId),
    );
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    const resolved = resolvePendingApprovalResolver(
      runtime,
      makeSuccessResponse("perm-other"),
    );
    expect(resolved).toBe(false);
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(runtime.pendingApprovalResolvers.size).toBe(1);

    const handledPending = pending.catch((error) => error);
    rejectPendingApprovalResolvers(runtime, "cleanup");
    const cleanupError = await handledPending;
    expect(cleanupError).toBeInstanceOf(Error);
    expect((cleanupError as Error).message).toBe("cleanup");
  });

  test("cleanup rejects all pending resolvers", async () => {
    const runtime = __listenClientTestUtils.createRuntime();
    const first = new Promise<ControlResponseBody>((resolve, reject) => {
      runtime.pendingApprovalResolvers.set("perm-a", { resolve, reject });
    });
    const second = new Promise<ControlResponseBody>((resolve, reject) => {
      runtime.pendingApprovalResolvers.set("perm-b", { resolve, reject });
    });

    rejectPendingApprovalResolvers(runtime, "socket closed");
    expect(runtime.pendingApprovalResolvers.size).toBe(0);
    await expect(first).rejects.toThrow("socket closed");
    await expect(second).rejects.toThrow("socket closed");
  });

  test("stopRuntime rejects pending resolvers even when callbacks are suppressed", async () => {
    const runtime = __listenClientTestUtils.createRuntime();
    const pending = new Promise<ControlResponseBody>((resolve, reject) => {
      runtime.pendingApprovalResolvers.set("perm-stop", { resolve, reject });
    });
    const socket = new MockSocket(WebSocket.OPEN);
    runtime.socket = socket as unknown as WebSocket;

    __listenClientTestUtils.stopRuntime(runtime, true);

    expect(runtime.pendingApprovalResolvers.size).toBe(0);
    expect(socket.removeAllListenersCalls).toBe(1);
    expect(socket.closeCalls).toBe(1);
    await expect(pending).rejects.toThrow("Listener runtime stopped");
  });
});

describe("listen-client requestApprovalOverWS", () => {
  test("rejects immediately when socket is not open", async () => {
    const runtime = __listenClientTestUtils.createRuntime();
    const socket = new MockSocket(WebSocket.CLOSED);
    const requestId = "perm-closed";

    await expect(
      requestApprovalOverWS(
        runtime,
        socket as unknown as WebSocket,
        requestId,
        makeControlRequest(requestId),
      ),
    ).rejects.toThrow("WebSocket not open");
    expect(runtime.pendingApprovalResolvers.size).toBe(0);
  });

  test("cleans up resolver when send throws", async () => {
    const runtime = __listenClientTestUtils.createRuntime();
    const socket = new MockSocket(WebSocket.OPEN);
    socket.sendImpl = () => {
      throw new Error("send failed");
    };
    const requestId = "perm-send-fail";

    await expect(
      requestApprovalOverWS(
        runtime,
        socket as unknown as WebSocket,
        requestId,
        makeControlRequest(requestId),
      ),
    ).rejects.toThrow("send failed");
    expect(runtime.pendingApprovalResolvers.size).toBe(0);
  });
});
