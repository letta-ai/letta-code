import { describe, expect, test } from "bun:test";
import WebSocket from "ws";
import type { ApprovalResponseBody, ControlRequest } from "@/types/protocol_v2";
import {
  rejectPendingApprovalResolvers,
  requestApprovalOverWS,
  resolvePendingApprovalResolver,
} from "./approval";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { createRuntime, stopRuntime } from "./lifecycle";
import { buildLoopStatus } from "./protocol-outbound";
import { clearConversationRuntimeState } from "./runtime";
import type { ConversationRuntime } from "./types";

class MockSocket {
  readonly kind = "local" as const;
  readonly bufferedAmount = 0;
  readyState: number;
  closeCalls = 0;
  removeAllListenersCalls = 0;
  sentPayloads: string[] = [];

  constructor(readyState: number = WebSocket.OPEN) {
    this.readyState = readyState;
  }

  send(data: string): void {
    this.sentPayloads.push(data);
  }

  isOpen(): boolean {
    return this.readyState === WebSocket.OPEN;
  }

  close(): void {
    this.closeCalls += 1;
  }

  removeAllListeners(): this {
    this.removeAllListenersCalls += 1;
    return this;
  }
}

function createScopedRuntime(
  agentId: string = "agent-1",
  conversationId: string = "default",
): ConversationRuntime {
  return getOrCreateScopedRuntime(createRuntime(), agentId, conversationId);
}

function beginApprovalWait(runtime: ConversationRuntime) {
  return runtime.turnLifecycle.begin({
    origin: "message",
    workingDirectory: process.cwd(),
    initialStatus: "WAITING_ON_APPROVAL",
  });
}

function makeControlRequest(requestId: string): ControlRequest {
  return {
    type: "control_request",
    request_id: requestId,
    request: {
      subtype: "can_use_tool",
      tool_name: "Bash",
      input: {},
      tool_call_id: requestId.replace("perm-", "call-"),
      permission_suggestions: [],
      blocked_path: null,
    },
  };
}

function makeSuccessResponse(requestId: string): ApprovalResponseBody {
  return {
    request_id: requestId,
    decision: { behavior: "allow" },
  };
}

describe("listener approval lifecycle", () => {
  test("resolving an approval does not falsely finalize its enclosing turn", async () => {
    const runtime = createScopedRuntime();
    const socket = new MockSocket();
    const turnLease = beginApprovalWait(runtime);
    const pending = requestApprovalOverWS(
      runtime,
      socket,
      turnLease,
      "perm-status",
      makeControlRequest("perm-status"),
    );

    expect(
      resolvePendingApprovalResolver(
        runtime,
        makeSuccessResponse("perm-status"),
      ),
    ).toBe(true);
    await expect(pending).resolves.toEqual(makeSuccessResponse("perm-status"));
    expect(runtime.loopStatus).toBe("WAITING_ON_APPROVAL");
    expect(runtime.isProcessing).toBe(true);
  });

  test("approval routing and state stay isolated by conversation", async () => {
    const listener = createRuntime();
    const runtimeA = getOrCreateScopedRuntime(listener, "agent-1", "conv-a");
    const runtimeB = getOrCreateScopedRuntime(listener, "agent-1", "conv-b");
    const socket = new MockSocket();
    const turnLeaseA = beginApprovalWait(runtimeA);
    const turnLeaseB = beginApprovalWait(runtimeB);

    const pendingA = requestApprovalOverWS(
      runtimeA,
      socket,
      turnLeaseA,
      "perm-a",
      makeControlRequest("perm-a"),
    );
    const pendingB = requestApprovalOverWS(
      runtimeB,
      socket,
      turnLeaseB,
      "perm-b",
      makeControlRequest("perm-b"),
    );

    expect(listener.approvalRuntimeKeyByRequestId.get("perm-a")).toBe(
      runtimeA.key,
    );
    expect(listener.approvalRuntimeKeyByRequestId.get("perm-b")).toBe(
      runtimeB.key,
    );
    expect(
      resolvePendingApprovalResolver(runtimeA, makeSuccessResponse("perm-a")),
    ).toBe(true);
    await expect(pendingA).resolves.toEqual(makeSuccessResponse("perm-a"));
    expect(runtimeB.pendingApprovalResolvers.size).toBe(1);
    expect(
      buildLoopStatus(listener, {
        agent_id: "agent-1",
        conversation_id: "conv-b",
      }).status,
    ).toBe("WAITING_ON_APPROVAL");

    resolvePendingApprovalResolver(runtimeB, makeSuccessResponse("perm-b"));
    await expect(pendingB).resolves.toEqual(makeSuccessResponse("perm-b"));
  });

  test("a non-matching response leaves the pending resolver intact", async () => {
    const runtime = createScopedRuntime();
    const socket = new MockSocket();
    const turnLease = beginApprovalWait(runtime);
    const pending = requestApprovalOverWS(
      runtime,
      socket,
      turnLease,
      "perm-1",
      makeControlRequest("perm-1"),
    );

    expect(
      resolvePendingApprovalResolver(runtime, makeSuccessResponse("perm-2")),
    ).toBe(false);
    expect(runtime.pendingApprovalResolvers.size).toBe(1);

    rejectPendingApprovalResolvers(runtime, "cleanup");
    await expect(pending).rejects.toThrow("cleanup");
  });

  test("conversation cleanup rejects approvals and resets ownership atomically", async () => {
    const runtime = createScopedRuntime();
    const socket = new MockSocket();
    const turnLease = beginApprovalWait(runtime);
    const pending = requestApprovalOverWS(
      runtime,
      socket,
      turnLease,
      "perm-cleanup",
      makeControlRequest("perm-cleanup"),
    );

    rejectPendingApprovalResolvers(runtime, "socket closed");
    clearConversationRuntimeState(runtime);

    await expect(pending).rejects.toThrow("socket closed");
    expect(runtime.turnLifecycle.kind).toBe("idle");
    expect(runtime.isProcessing).toBe(false);
    expect(runtime.cancelRequested).toBe(false);
    expect(runtime.loopStatus).toBe("WAITING_ON_INPUT");
  });

  test("stopRuntime rejects pending approvals when callbacks are suppressed", async () => {
    const listener = createRuntime();
    const runtime = getOrCreateScopedRuntime(listener, "agent-1", "default");
    const socket = new MockSocket();
    listener.socket = socket as unknown as WebSocket;
    const turnLease = beginApprovalWait(runtime);
    const pending = requestApprovalOverWS(
      runtime,
      socket,
      turnLease,
      "perm-stop",
      makeControlRequest("perm-stop"),
    );

    stopRuntime(listener, true);

    await expect(pending).rejects.toThrow("Listener runtime stopped");
    expect(socket.removeAllListenersCalls).toBe(1);
    expect(socket.closeCalls).toBe(1);
  });

  test("approval registration rejects closed and cancelling turns", async () => {
    const closedRuntime = createScopedRuntime();
    const closedTurnLease = beginApprovalWait(closedRuntime);
    await expect(
      requestApprovalOverWS(
        closedRuntime,
        new MockSocket(WebSocket.CLOSED),
        closedTurnLease,
        "perm-closed",
        makeControlRequest("perm-closed"),
      ),
    ).rejects.toThrow("WebSocket not open");

    const cancellingRuntime = createScopedRuntime();
    const turnLease = beginApprovalWait(cancellingRuntime);
    cancellingRuntime.turnLifecycle.requestCancellation();
    await expect(
      requestApprovalOverWS(
        cancellingRuntime,
        new MockSocket(),
        turnLease,
        "perm-cancelled",
        makeControlRequest("perm-cancelled"),
      ),
    ).rejects.toThrow("Cancelled by user");
  });

  test("a stale approval request cannot register against a replacement turn", async () => {
    const runtime = createScopedRuntime();
    const socket = new MockSocket();
    const staleTurnLease = beginApprovalWait(runtime);
    clearConversationRuntimeState(runtime);
    const replacementTurnLease = runtime.turnLifecycle.begin({
      origin: "message",
      workingDirectory: process.cwd(),
    });

    await expect(
      requestApprovalOverWS(
        runtime,
        socket,
        staleTurnLease,
        "perm-stale",
        makeControlRequest("perm-stale"),
      ),
    ).rejects.toThrow("Cancelled by user");

    expect(runtime.turnLifecycle.isCurrent(replacementTurnLease)).toBe(true);
    expect(runtime.loopStatus).toBe("SENDING_API_REQUEST");
    expect(runtime.pendingApprovalResolvers.size).toBe(0);
    expect(socket.sentPayloads).toEqual([]);
  });

  test("an abort after registration removes and rejects the resolver", async () => {
    const runtime = createScopedRuntime();
    const socket = new MockSocket();
    const turnLease = beginApprovalWait(runtime);
    const pending = requestApprovalOverWS(
      runtime,
      socket,
      turnLease,
      "perm-abort",
      makeControlRequest("perm-abort"),
    );

    expect(runtime.pendingApprovalResolvers.size).toBe(1);
    runtime.turnLifecycle.requestCancellation();

    await expect(pending).rejects.toThrow("Cancelled by user");
    expect(runtime.pendingApprovalResolvers.size).toBe(0);
    expect(runtime.listener.approvalRuntimeKeyByRequestId.size).toBe(0);
  });
});
