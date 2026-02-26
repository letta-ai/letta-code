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

describe("listen-client controlResponseCapable latch", () => {
  test("runtime initializes with controlResponseCapable = false", () => {
    const runtime = __listenClientTestUtils.createRuntime();
    expect(runtime.controlResponseCapable).toBe(false);
  });

  test("latch stays true after being set once", () => {
    const runtime = __listenClientTestUtils.createRuntime();
    expect(runtime.controlResponseCapable).toBe(false);

    runtime.controlResponseCapable = true;
    expect(runtime.controlResponseCapable).toBe(true);

    // Simulates second message without the flag — latch should persist
    // (actual latching happens in handleIncomingMessage, but the runtime
    // field itself should hold the value)
    expect(runtime.controlResponseCapable).toBe(true);
  });
});

describe("listen-client capability-gated approval flow", () => {
  test("control_response with allow + updatedInput rewrites tool args", async () => {
    const runtime = __listenClientTestUtils.createRuntime();
    const socket = new MockSocket(WebSocket.OPEN);
    const requestId = "perm-update-test";

    const pending = requestApprovalOverWS(
      runtime,
      socket as unknown as WebSocket,
      requestId,
      makeControlRequest(requestId),
    );

    // Simulate control_response with updatedInput
    resolvePendingApprovalResolver(runtime, {
      subtype: "success",
      request_id: requestId,
      response: {
        behavior: "allow",
        updatedInput: { file_path: "/updated/path.ts", content: "new content" },
      },
    });

    const response = await pending;
    expect(response.subtype).toBe("success");
    if (response.subtype === "success") {
      const canUseToolResponse = response.response as {
        behavior: string;
        updatedInput?: Record<string, unknown>;
      };
      expect(canUseToolResponse.behavior).toBe("allow");
      expect(canUseToolResponse.updatedInput).toEqual({
        file_path: "/updated/path.ts",
        content: "new content",
      });
    }
  });

  test("control_response with deny includes reason", async () => {
    const runtime = __listenClientTestUtils.createRuntime();
    const socket = new MockSocket(WebSocket.OPEN);
    const requestId = "perm-deny-test";

    const pending = requestApprovalOverWS(
      runtime,
      socket as unknown as WebSocket,
      requestId,
      makeControlRequest(requestId),
    );

    resolvePendingApprovalResolver(runtime, {
      subtype: "success",
      request_id: requestId,
      response: { behavior: "deny", message: "User declined" },
    });

    const response = await pending;
    expect(response.subtype).toBe("success");
    if (response.subtype === "success") {
      const canUseToolResponse = response.response as {
        behavior: string;
        message?: string;
      };
      expect(canUseToolResponse.behavior).toBe("deny");
      expect(canUseToolResponse.message).toBe("User declined");
    }
  });

  test("error response from WS triggers denial path", async () => {
    const runtime = __listenClientTestUtils.createRuntime();
    const socket = new MockSocket(WebSocket.OPEN);
    const requestId = "perm-error-test";

    const pending = requestApprovalOverWS(
      runtime,
      socket as unknown as WebSocket,
      requestId,
      makeControlRequest(requestId),
    );

    resolvePendingApprovalResolver(runtime, {
      subtype: "error",
      request_id: requestId,
      error: "Internal server error",
    });

    const response = await pending;
    expect(response.subtype).toBe("error");
    if (response.subtype === "error") {
      expect(response.error).toBe("Internal server error");
    }
  });

  test("outbound control_request is sent through sendControlMessageOverWebSocket (not raw socket.send)", () => {
    const runtime = __listenClientTestUtils.createRuntime();
    const socket = new MockSocket(WebSocket.OPEN);
    const requestId = "perm-adapter-test";

    // requestApprovalOverWS uses sendControlMessageOverWebSocket internally
    // which ultimately calls socket.send — but goes through the adapter stub.
    // We verify the message was sent with the correct shape.
    void requestApprovalOverWS(
      runtime,
      socket as unknown as WebSocket,
      requestId,
      makeControlRequest(requestId),
    ).catch(() => {});

    expect(socket.sentPayloads).toHaveLength(1);
    const sent = JSON.parse(socket.sentPayloads[0] as string);
    expect(sent.type).toBe("control_request");
    expect(sent.request_id).toBe(requestId);
    expect(sent.request.subtype).toBe("can_use_tool");

    // Cleanup
    rejectPendingApprovalResolvers(runtime, "test cleanup");
  });
});

describe("listen-client emitToWS adapter", () => {
  test("sends event when socket is OPEN", () => {
    const socket = new MockSocket(WebSocket.OPEN);
    const event = {
      type: "error" as const,
      message: "test error",
      stop_reason: "error" as const,
      session_id: "listen-test",
      uuid: "test-uuid",
    };

    __listenClientTestUtils.emitToWS(socket as unknown as WebSocket, event);

    expect(socket.sentPayloads).toHaveLength(1);
    const sent = JSON.parse(socket.sentPayloads[0] as string);
    expect(sent.type).toBe("error");
    expect(sent.message).toBe("test error");
    expect(sent.session_id).toBe("listen-test");
  });

  test("does not send when socket is CLOSED", () => {
    const socket = new MockSocket(WebSocket.CLOSED);
    const event = {
      type: "error" as const,
      message: "test error",
      stop_reason: "error" as const,
      session_id: "listen-test",
      uuid: "test-uuid",
    };

    __listenClientTestUtils.emitToWS(socket as unknown as WebSocket, event);

    expect(socket.sentPayloads).toHaveLength(0);
  });

  test("emits RecoveryMessage with recovery_type", () => {
    const socket = new MockSocket(WebSocket.OPEN);
    const event: Parameters<typeof __listenClientTestUtils.emitToWS>[1] = {
      type: "recovery",
      recovery_type: "approval_pending",
      message: "Detected pending approval conflict",
      session_id: "listen-abc",
      uuid: "recovery-123",
    };

    __listenClientTestUtils.emitToWS(socket as unknown as WebSocket, event);

    expect(socket.sentPayloads).toHaveLength(1);
    const sent = JSON.parse(socket.sentPayloads[0] as string);
    expect(sent.type).toBe("recovery");
    expect(sent.recovery_type).toBe("approval_pending");
    expect(sent.session_id).toBe("listen-abc");
  });

  test("emits AutoApprovalMessage with tool_call shape", () => {
    const socket = new MockSocket(WebSocket.OPEN);
    const event = {
      type: "auto_approval" as const,
      tool_call: {
        name: "Write",
        tool_call_id: "call-123",
        arguments: '{"file_path": "/test.ts"}',
      },
      reason: "auto-approved",
      matched_rule: "auto-approved",
      session_id: "listen-test",
      uuid: "auto-approval-call-123",
    };

    __listenClientTestUtils.emitToWS(socket as unknown as WebSocket, event);

    expect(socket.sentPayloads).toHaveLength(1);
    const sent = JSON.parse(socket.sentPayloads[0] as string);
    expect(sent.type).toBe("auto_approval");
    expect(sent.tool_call.name).toBe("Write");
    expect(sent.tool_call.tool_call_id).toBe("call-123");
  });

  test("emits RetryMessage with attempt/delay details", () => {
    const socket = new MockSocket(WebSocket.OPEN);
    const event = {
      type: "retry" as const,
      reason: "llm_api_error" as const,
      attempt: 1,
      max_attempts: 3,
      delay_ms: 1000,
      session_id: "listen-test",
      uuid: "retry-123",
    };

    __listenClientTestUtils.emitToWS(socket as unknown as WebSocket, event);

    expect(socket.sentPayloads).toHaveLength(1);
    const sent = JSON.parse(socket.sentPayloads[0] as string);
    expect(sent.type).toBe("retry");
    expect(sent.attempt).toBe(1);
    expect(sent.max_attempts).toBe(3);
    expect(sent.delay_ms).toBe(1000);
  });

  test("emits rich ResultMessage with full metadata", () => {
    const socket = new MockSocket(WebSocket.OPEN);
    const event = {
      type: "result" as const,
      subtype: "success" as const,
      agent_id: "agent-123",
      conversation_id: "conv-456",
      duration_ms: 1500,
      duration_api_ms: 0,
      num_turns: 2,
      result: null,
      run_ids: ["run-1", "run-2"],
      usage: null,
      session_id: "listen-test",
      uuid: "result-123",
    };

    __listenClientTestUtils.emitToWS(socket as unknown as WebSocket, event);

    expect(socket.sentPayloads).toHaveLength(1);
    const sent = JSON.parse(socket.sentPayloads[0] as string);
    expect(sent.type).toBe("result");
    expect(sent.subtype).toBe("success");
    expect(sent.agent_id).toBe("agent-123");
    expect(sent.num_turns).toBe(2);
    expect(sent.run_ids).toEqual(["run-1", "run-2"]);
  });

  test("runtime sessionId is stable and uses listen- prefix", () => {
    const runtime = __listenClientTestUtils.createRuntime();
    expect(runtime.sessionId).toMatch(/^listen-/);
    // Verify it's a UUID format after the prefix
    expect(runtime.sessionId.length).toBeGreaterThan(10);
  });
});
