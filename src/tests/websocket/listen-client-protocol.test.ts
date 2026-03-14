import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import type { ApprovalCreate } from "@letta-ai/letta-client/resources/agents/messages";
import WebSocket from "ws";
import { buildConversationMessagesCreateRequestBody } from "../../agent/message";
import { INTERRUPTED_BY_USER } from "../../constants";
import type { MessageQueueItem } from "../../queue/queueRuntime";
import type {
  ApprovalResponseBody,
  ControlRequest,
} from "../../types/protocol_v2";
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

function makeSuccessResponse(requestId: string): ApprovalResponseBody {
  return {
    request_id: requestId,
    decision: { behavior: "allow" },
  };
}

describe("listen-client parseServerMessage", () => {
  test("parses valid input approval_response command", () => {
    const parsed = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "input",
          runtime: { agent_id: "agent-1", conversation_id: "default" },
          payload: {
            kind: "approval_response",
            request_id: "perm-1",
            decision: { behavior: "allow" },
          },
        }),
      ),
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.type).toBe("input");
  });

  test("classifies invalid input approval_response payloads", () => {
    const missingResponse = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "input",
          runtime: { agent_id: "agent-1", conversation_id: "default" },
          payload: { kind: "approval_response" },
        }),
      ),
    );
    expect(missingResponse).not.toBeNull();
    expect(missingResponse?.type).toBe("__invalid_input");

    const missingRequestId = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "input",
          runtime: { agent_id: "agent-1", conversation_id: "default" },
          payload: {
            kind: "approval_response",
            decision: { behavior: "allow" },
          },
        }),
      ),
    );
    expect(missingRequestId).not.toBeNull();
    expect(missingRequestId?.type).toBe("__invalid_input");
  });

  test("classifies unknown input payload kinds for explicit protocol rejection", () => {
    const unknownKind = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "input",
          runtime: { agent_id: "agent-1", conversation_id: "default" },
          payload: { kind: "slash_command", command: "/model" },
        }),
      ),
    );
    expect(unknownKind).not.toBeNull();
    expect(unknownKind?.type).toBe("__invalid_input");
  });

  test("accepts input create_message and change_device_state", () => {
    const msg = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "input",
          runtime: { agent_id: "agent-1", conversation_id: "default" },
          payload: { kind: "create_message", messages: [] },
        }),
      ),
    );
    const changeDeviceState = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "change_device_state",
          runtime: { agent_id: "agent-1", conversation_id: "default" },
          payload: { mode: "default" },
        }),
      ),
    );
    expect(msg?.type).toBe("input");
    expect(changeDeviceState?.type).toBe("change_device_state");
  });

  test("parses abort_message as the canonical abort command", () => {
    const abort = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "abort_message",
          runtime: { agent_id: "agent-1", conversation_id: "default" },
          request_id: "abort-1",
          run_id: "run-1",
        }),
      ),
    );
    expect(abort?.type).toBe("abort_message");
  });

  test("rejects legacy cancel_run in hard-cut v2 protocol", () => {
    const legacyCancel = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "cancel_run",
          request_id: "cancel-1",
          run_id: "run-1",
        }),
      ),
    );
    expect(legacyCancel).toBeNull();
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
      request_id: requestId,
      decision: { behavior: "allow" },
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
    const first = new Promise<ApprovalResponseBody>((resolve, reject) => {
      runtime.pendingApprovalResolvers.set("perm-a", { resolve, reject });
    });
    const second = new Promise<ApprovalResponseBody>((resolve, reject) => {
      runtime.pendingApprovalResolvers.set("perm-b", { resolve, reject });
    });

    rejectPendingApprovalResolvers(runtime, "socket closed");
    expect(runtime.pendingApprovalResolvers.size).toBe(0);
    await expect(first).rejects.toThrow("socket closed");
    await expect(second).rejects.toThrow("socket closed");
  });

  test("stopRuntime rejects pending resolvers even when callbacks are suppressed", async () => {
    const runtime = __listenClientTestUtils.createRuntime();
    const pending = new Promise<ApprovalResponseBody>((resolve, reject) => {
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

describe("listen-client conversation-scoped protocol events", () => {
  test("queue lifecycle events are emitted as stream_delta with runtime scope", () => {
    const runtime = __listenClientTestUtils.createRuntime();
    const socket = new MockSocket(WebSocket.OPEN);
    runtime.socket = socket as unknown as WebSocket;

    const input: Omit<MessageQueueItem, "id" | "enqueuedAt"> = {
      kind: "message",
      source: "user",
      content: "hello",
      clientMessageId: "cm-queue-1",
      agentId: "agent-default",
      conversationId: "default",
    };
    const item = runtime.queueRuntime.enqueue(input);
    expect(item).not.toBeNull();

    runtime.queueRuntime.tryDequeue("runtime_busy");

    const outbound = socket.sentPayloads.map((payload) =>
      JSON.parse(payload as string),
    );
    const enqueued = outbound.find(
      (payload) =>
        payload.type === "stream_delta" &&
        payload.delta?.type === "queue_item_enqueued",
    );
    expect(enqueued).toBeDefined();
    expect(enqueued.runtime.agent_id).toBe("agent-default");
    expect(enqueued.runtime.conversation_id).toBe("default");

    const blocked = outbound.find(
      (payload) =>
        payload.type === "stream_delta" &&
        payload.delta?.type === "queue_blocked",
    );
    expect(blocked).toBeDefined();
    expect(blocked.runtime.agent_id).toBe("agent-default");
    expect(blocked.runtime.conversation_id).toBe("default");
  });

  test("cancel_ack is projected through stream_delta with scoped runtime", () => {
    const runtime = __listenClientTestUtils.createRuntime();
    const socket = new MockSocket(WebSocket.OPEN);
    runtime.activeAgentId = "agent-123";
    runtime.activeConversationId = "default";
    runtime.activeRunId = "run-123";

    __listenClientTestUtils.emitCancelAck(
      socket as unknown as WebSocket,
      runtime,
      {
        requestId: "cancel-1",
        accepted: true,
      },
    );

    const sent = JSON.parse(socket.sentPayloads[0] as string);
    expect(sent.type).toBe("stream_delta");
    expect(sent.runtime.agent_id).toBe("agent-123");
    expect(sent.runtime.conversation_id).toBe("default");
    expect(sent.delta.type).toBe("cancel_ack");
    expect(sent.delta.run_id).toBe("run-123");
  });

  test("queue_batch_dequeued keeps scope through stream_delta runtime envelope", () => {
    const runtime = __listenClientTestUtils.createRuntime();
    const socket = new MockSocket(WebSocket.OPEN);
    runtime.socket = socket as unknown as WebSocket;

    const input: Omit<MessageQueueItem, "id" | "enqueuedAt"> = {
      kind: "message",
      source: "user",
      content: "hello",
      clientMessageId: "cm-queue-2",
      agentId: "agent-xyz",
      conversationId: "conv-xyz",
    };

    runtime.queueRuntime.enqueue(input);
    runtime.queueRuntime.tryDequeue(null);

    const outbound = socket.sentPayloads.map((payload) =>
      JSON.parse(payload as string),
    );
    const dequeued = outbound.find(
      (payload) =>
        payload.type === "stream_delta" &&
        payload.delta?.type === "queue_batch_dequeued",
    );
    expect(dequeued).toBeDefined();
    expect(dequeued.runtime.agent_id).toBe("agent-xyz");
    expect(dequeued.runtime.conversation_id).toBe("conv-xyz");
  });
});

describe("listen-client v2 status builders", () => {
  test("buildLoopStatus defaults to WAITING_ON_INPUT with no active run", () => {
    const runtime = __listenClientTestUtils.createRuntime();
    const loopStatus = __listenClientTestUtils.buildLoopStatus(runtime);
    expect(loopStatus.status).toBe("WAITING_ON_INPUT");
    expect(loopStatus.active_run_ids).toEqual([]);
    expect(loopStatus.queue).toEqual([]);
  });

  test("buildDeviceStatus includes the effective working directory", () => {
    const runtime = __listenClientTestUtils.createRuntime();
    const deviceStatus = __listenClientTestUtils.buildDeviceStatus(runtime);
    expect(typeof deviceStatus.current_working_directory).toBe("string");
    expect(
      (deviceStatus.current_working_directory ?? "").length,
    ).toBeGreaterThan(0);
    expect(deviceStatus.current_toolset_preference).toBe("auto");
  });

  test("scopes working directory to requested agent and conversation", () => {
    const runtime = __listenClientTestUtils.createRuntime();
    __listenClientTestUtils.setConversationWorkingDirectory(
      runtime,
      "agent-a",
      "conv-a",
      "/repo/a",
    );
    __listenClientTestUtils.setConversationWorkingDirectory(
      runtime,
      "agent-b",
      "default",
      "/repo/b",
    );

    const activeStatus = __listenClientTestUtils.buildDeviceStatus(runtime, {
      agent_id: "agent-a",
      conversation_id: "conv-a",
    });
    expect(activeStatus.current_working_directory).toBe("/repo/a");

    const defaultStatus = __listenClientTestUtils.buildDeviceStatus(runtime, {
      agent_id: "agent-b",
      conversation_id: "default",
    });
    expect(defaultStatus.current_working_directory).toBe("/repo/b");
  });
});

describe("listen-client cwd change handling", () => {
  test("resolves relative cwd changes against the conversation cwd and emits update_device_status", async () => {
    const runtime = __listenClientTestUtils.createRuntime();
    const socket = new MockSocket(WebSocket.OPEN);
    const tempRoot = await mkdtemp(join(os.tmpdir(), "letta-listen-cwd-"));
    const repoDir = join(tempRoot, "repo");
    const serverDir = join(repoDir, "server");
    const clientDir = join(repoDir, "client");
    await mkdir(serverDir, { recursive: true });
    await mkdir(clientDir, { recursive: true });
    const normalizedServerDir = await realpath(serverDir);
    const normalizedClientDir = await realpath(clientDir);

    try {
      __listenClientTestUtils.setConversationWorkingDirectory(
        runtime,
        "agent-1",
        "conv-1",
        normalizedServerDir,
      );
      runtime.activeAgentId = "agent-1";
      runtime.activeConversationId = "conv-1";
      runtime.activeWorkingDirectory = normalizedServerDir;

      await __listenClientTestUtils.handleCwdChange(
        {
          agentId: "agent-1",
          conversationId: "conv-1",
          cwd: "../client",
        },
        socket as unknown as WebSocket,
        runtime,
      );

      expect(
        __listenClientTestUtils.getConversationWorkingDirectory(
          runtime,
          "agent-1",
          "conv-1",
        ),
      ).toBe(normalizedClientDir);

      expect(socket.sentPayloads).toHaveLength(1);
      const updated = JSON.parse(socket.sentPayloads[0] as string);
      expect(updated.type).toBe("update_device_status");
      expect(updated.runtime.agent_id).toBe("agent-1");
      expect(updated.runtime.conversation_id).toBe("conv-1");
      expect(updated.device_status.current_working_directory).toBe(
        normalizedClientDir,
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

describe("listen-client interrupt queue projection", () => {
  test("consumes queued interrupted tool returns with tool ids", () => {
    const runtime = __listenClientTestUtils.createRuntime();

    __listenClientTestUtils.populateInterruptQueue(runtime, {
      lastExecutionResults: null,
      lastExecutingToolCallIds: ["call-running-1"],
      lastNeedsUserInputToolCallIds: [],
      agentId: "agent-1",
      conversationId: "conv-1",
    });

    const consumed = __listenClientTestUtils.consumeInterruptQueue(
      runtime,
      "agent-1",
      "conv-1",
    );
    expect(consumed).not.toBeNull();
    expect(consumed?.interruptedToolCallIds).toEqual(["call-running-1"]);
    expect(consumed?.approvalMessage.approvals).toEqual([
      {
        type: "tool",
        tool_call_id: "call-running-1",
        status: "error",
        tool_return: INTERRUPTED_BY_USER,
      },
    ]);
    expect(
      __listenClientTestUtils.consumeInterruptQueue(
        runtime,
        "agent-1",
        "conv-1",
      ),
    ).toBeNull();
  });

  test("approval-denial fallback does not set interrupted tool ids", () => {
    const runtime = __listenClientTestUtils.createRuntime();

    __listenClientTestUtils.populateInterruptQueue(runtime, {
      lastExecutionResults: null,
      lastExecutingToolCallIds: [],
      lastNeedsUserInputToolCallIds: ["call-awaiting-approval"],
      agentId: "agent-1",
      conversationId: "conv-1",
    });

    const consumed = __listenClientTestUtils.consumeInterruptQueue(
      runtime,
      "agent-1",
      "conv-1",
    );
    expect(consumed).not.toBeNull();
    expect(consumed?.interruptedToolCallIds).toEqual([]);
    expect(consumed?.approvalMessage.approvals[0]).toMatchObject({
      type: "approval",
      tool_call_id: "call-awaiting-approval",
      approve: false,
    });
  });
});

describe("listen-client capability-gated approval flow", () => {
  test("approval_response with allow + updated_input rewrites tool args", async () => {
    const runtime = __listenClientTestUtils.createRuntime();
    const socket = new MockSocket(WebSocket.OPEN);
    const requestId = "perm-update-test";

    const pending = requestApprovalOverWS(
      runtime,
      socket as unknown as WebSocket,
      requestId,
      makeControlRequest(requestId),
    );

    // Simulate approval_response with updated_input
    resolvePendingApprovalResolver(runtime, {
      request_id: requestId,
      decision: {
        behavior: "allow",
        updated_input: {
          file_path: "/updated/path.ts",
          content: "new content",
        },
      },
    });

    const response = await pending;
    expect("decision" in response).toBe(true);
    if ("decision" in response) {
      const canUseToolResponse = response.decision as {
        behavior: string;
        updated_input?: Record<string, unknown>;
      };
      expect(canUseToolResponse.behavior).toBe("allow");
      expect(canUseToolResponse.updated_input).toEqual({
        file_path: "/updated/path.ts",
        content: "new content",
      });
    }
  });

  test("approval_response with deny includes reason", async () => {
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
      request_id: requestId,
      decision: { behavior: "deny", message: "User declined" },
    });

    const response = await pending;
    expect("decision" in response).toBe(true);
    if ("decision" in response) {
      const canUseToolResponse = response.decision as {
        behavior: string;
        message?: string;
      };
      expect(canUseToolResponse.behavior).toBe("deny");
      expect(canUseToolResponse.message).toBe("User declined");
    }
  });

  test("approval_response error triggers denial path", async () => {
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
      request_id: requestId,
      error: "Internal server error",
    });

    const response = await pending;
    expect("error" in response).toBe(true);
    if ("error" in response) {
      expect(response.error).toBe("Internal server error");
    }
  });

  test("requestApprovalOverWS exposes the control request through device status instead of stream_delta", () => {
    const runtime = __listenClientTestUtils.createRuntime();
    const socket = new MockSocket(WebSocket.OPEN);
    const requestId = "perm-adapter-test";

    void requestApprovalOverWS(
      runtime,
      socket as unknown as WebSocket,
      requestId,
      makeControlRequest(requestId),
    ).catch(() => {});

    expect(socket.sentPayloads).toHaveLength(2);
    const [loopStatus, deviceStatus] = socket.sentPayloads.map((payload) =>
      JSON.parse(payload as string),
    );
    expect(loopStatus.type).toBe("update_loop_status");
    expect(loopStatus.loop_status.status).toBe("WAITING_ON_APPROVAL");
    expect(deviceStatus.type).toBe("update_device_status");
    expect(deviceStatus.device_status.pending_control_requests).toEqual([
      {
        request_id: requestId,
        request: makeControlRequest(requestId).request,
      },
    ]);

    // Cleanup
    rejectPendingApprovalResolvers(runtime, "test cleanup");
  });
});

describe("listen-client approval recovery batch correlation", () => {
  test("resolves the original batch id from pending tool call ids", () => {
    const runtime = __listenClientTestUtils.createRuntime();
    __listenClientTestUtils.rememberPendingApprovalBatchIds(
      runtime,
      [{ toolCallId: "tool-1" }, { toolCallId: "tool-2" }],
      "batch-123",
    );

    expect(
      __listenClientTestUtils.resolvePendingApprovalBatchId(runtime, [
        { toolCallId: "tool-1" },
        { toolCallId: "tool-2" },
      ]),
    ).toBe("batch-123");
  });

  test("returns null when pending approvals map to multiple batches", () => {
    const runtime = __listenClientTestUtils.createRuntime();
    __listenClientTestUtils.rememberPendingApprovalBatchIds(
      runtime,
      [{ toolCallId: "tool-a" }],
      "batch-a",
    );
    __listenClientTestUtils.rememberPendingApprovalBatchIds(
      runtime,
      [{ toolCallId: "tool-b" }],
      "batch-b",
    );

    expect(
      __listenClientTestUtils.resolvePendingApprovalBatchId(runtime, [
        { toolCallId: "tool-a" },
        { toolCallId: "tool-b" },
      ]),
    ).toBeNull();
  });

  test("returns null when one pending approval mapping is missing", () => {
    const runtime = __listenClientTestUtils.createRuntime();
    __listenClientTestUtils.rememberPendingApprovalBatchIds(
      runtime,
      [{ toolCallId: "tool-a" }],
      "batch-a",
    );

    expect(
      __listenClientTestUtils.resolvePendingApprovalBatchId(runtime, [
        { toolCallId: "tool-a" },
        { toolCallId: "tool-missing" },
      ]),
    ).toBeNull();
  });

  test("clears correlation after approvals are executed", () => {
    const runtime = __listenClientTestUtils.createRuntime();
    __listenClientTestUtils.rememberPendingApprovalBatchIds(
      runtime,
      [{ toolCallId: "tool-x" }],
      "batch-x",
    );
    __listenClientTestUtils.clearPendingApprovalBatchIds(runtime, [
      { toolCallId: "tool-x" },
    ]);

    expect(
      __listenClientTestUtils.resolvePendingApprovalBatchId(runtime, [
        { toolCallId: "tool-x" },
      ]),
    ).toBeNull();
  });
});

describe("listen-client legacy stream adapter", () => {
  test("projects legacy deltas through stream_delta when socket is OPEN", () => {
    const runtime = __listenClientTestUtils.createRuntime();
    const socket = new MockSocket(WebSocket.OPEN);
    const event = {
      type: "cancel_ack" as const,
      request_id: "cancel-1",
      accepted: true,
      session_id: "listen-test",
      uuid: "test-uuid",
    };

    __listenClientTestUtils.emitLegacyStreamEvent(
      socket as unknown as WebSocket,
      event,
      runtime,
    );

    expect(socket.sentPayloads).toHaveLength(1);
    const sent = JSON.parse(socket.sentPayloads[0] as string);
    expect(sent.type).toBe("stream_delta");
    expect(sent.delta.type).toBe("cancel_ack");
    expect(sent.delta.request_id).toBe("cancel-1");
  });

  test("does not send when socket is CLOSED", () => {
    const runtime = __listenClientTestUtils.createRuntime();
    const socket = new MockSocket(WebSocket.CLOSED);
    const event = {
      type: "cancel_ack" as const,
      request_id: "cancel-1",
      accepted: true,
      session_id: "listen-test",
      uuid: "test-uuid",
    };

    __listenClientTestUtils.emitLegacyStreamEvent(
      socket as unknown as WebSocket,
      event,
      runtime,
    );

    expect(socket.sentPayloads).toHaveLength(0);
  });

  test("runtime sessionId is stable and uses listen- prefix", () => {
    const runtime = __listenClientTestUtils.createRuntime();
    expect(runtime.sessionId).toMatch(/^listen-/);
    expect(runtime.sessionId.length).toBeGreaterThan(10);
  });
});

describe("listen-client post-stop approval recovery policy", () => {
  test("retries when run detail indicates invalid tool call IDs", () => {
    const shouldRecover =
      __listenClientTestUtils.shouldAttemptPostStopApprovalRecovery({
        stopReason: "error",
        runIdsSeen: 1,
        retries: 0,
        runErrorDetail:
          "Invalid tool call IDs: expected [toolu_abc], got [toolu_def]",
        latestErrorText: null,
      });

    expect(shouldRecover).toBe(true);
  });

  test("retries when run detail indicates approval pending", () => {
    const shouldRecover =
      __listenClientTestUtils.shouldAttemptPostStopApprovalRecovery({
        stopReason: "error",
        runIdsSeen: 1,
        retries: 0,
        runErrorDetail: "Conversation is waiting for approval",
        latestErrorText: null,
      });

    expect(shouldRecover).toBe(true);
  });

  test("retries on generic no-run error heuristic", () => {
    const shouldRecover =
      __listenClientTestUtils.shouldAttemptPostStopApprovalRecovery({
        stopReason: "error",
        runIdsSeen: 0,
        retries: 0,
        runErrorDetail: null,
        latestErrorText: null,
      });

    expect(shouldRecover).toBe(true);
  });

  test("does not retry once retry budget is exhausted", () => {
    const shouldRecover =
      __listenClientTestUtils.shouldAttemptPostStopApprovalRecovery({
        stopReason: "error",
        runIdsSeen: 0,
        retries: 2,
        runErrorDetail: null,
        latestErrorText: null,
      });

    expect(shouldRecover).toBe(false);
  });
});

describe("listen-client interrupt persistence normalization", () => {
  test("forces interrupted in-flight tool results to status=error when cancelRequested", () => {
    const runtime = __listenClientTestUtils.createRuntime();
    runtime.cancelRequested = true;

    const normalized =
      __listenClientTestUtils.normalizeExecutionResultsForInterruptParity(
        runtime,
        [
          {
            type: "tool",
            tool_call_id: "tool-1",
            tool_return: "Interrupted by user",
            status: "success",
          },
        ],
        ["tool-1"],
      );

    expect(normalized).toEqual([
      {
        type: "tool",
        tool_call_id: "tool-1",
        tool_return: "Interrupted by user",
        status: "error",
      },
    ]);
  });

  test("leaves tool status unchanged when not in cancel flow", () => {
    const runtime = __listenClientTestUtils.createRuntime();
    runtime.cancelRequested = false;

    const normalized =
      __listenClientTestUtils.normalizeExecutionResultsForInterruptParity(
        runtime,
        [
          {
            type: "tool",
            tool_call_id: "tool-1",
            tool_return: "Interrupted by user",
            status: "success",
          },
        ],
        ["tool-1"],
      );

    expect(normalized).toEqual([
      {
        type: "tool",
        tool_call_id: "tool-1",
        tool_return: "Interrupted by user",
        status: "success",
      },
    ]);
  });
});

describe("listen-client interrupt persistence request body", () => {
  test("post-interrupt next-turn payload keeps interrupted tool returns as status=error", () => {
    const runtime = __listenClientTestUtils.createRuntime();
    const consumedAgentId = "agent-1";
    const consumedConversationId = "default";

    __listenClientTestUtils.populateInterruptQueue(runtime, {
      lastExecutionResults: null,
      lastExecutingToolCallIds: ["call-running-1"],
      lastNeedsUserInputToolCallIds: [],
      agentId: consumedAgentId,
      conversationId: consumedConversationId,
    });

    const consumed = __listenClientTestUtils.consumeInterruptQueue(
      runtime,
      consumedAgentId,
      consumedConversationId,
    );

    expect(consumed).not.toBeNull();
    if (!consumed) {
      throw new Error("Expected queued interrupt approvals to be consumed");
    }

    const requestBody = buildConversationMessagesCreateRequestBody(
      consumedConversationId,
      [
        consumed.approvalMessage,
        {
          type: "message",
          role: "user",
          content: "next user message after interrupt",
        },
      ],
      {
        agentId: consumedAgentId,
        streamTokens: true,
        background: true,
        approvalNormalization: {
          interruptedToolCallIds: consumed.interruptedToolCallIds,
        },
      },
      [],
    );

    const approvalMessage = requestBody.messages[0] as ApprovalCreate;
    expect(approvalMessage.type).toBe("approval");
    expect(approvalMessage.approvals?.[0]).toMatchObject({
      type: "tool",
      tool_call_id: "call-running-1",
      tool_return: INTERRUPTED_BY_USER,
      status: "error",
    });
  });
});

describe("listen-client tool_return wire normalization", () => {
  test("normalizes legacy top-level tool return fields to canonical tool_returns[]", () => {
    const normalized = __listenClientTestUtils.normalizeToolReturnWireMessage({
      message_type: "tool_return_message",
      id: "message-1",
      run_id: "run-1",
      tool_call_id: "call-1",
      status: "error",
      tool_return: [{ type: "text", text: "Interrupted by user" }],
    });

    expect(normalized).toEqual({
      message_type: "tool_return_message",
      id: "message-1",
      run_id: "run-1",
      tool_returns: [
        {
          tool_call_id: "call-1",
          status: "error",
          tool_return: "Interrupted by user",
        },
      ],
    });
    expect(normalized).not.toHaveProperty("tool_call_id");
    expect(normalized).not.toHaveProperty("status");
    expect(normalized).not.toHaveProperty("tool_return");
  });

  test("returns null for tool_return_message when no canonical status is available", () => {
    const normalized = __listenClientTestUtils.normalizeToolReturnWireMessage({
      message_type: "tool_return_message",
      id: "message-2",
      run_id: "run-2",
      tool_call_id: "call-2",
      tool_return: "maybe done",
    });

    expect(normalized).toBeNull();
  });
});
