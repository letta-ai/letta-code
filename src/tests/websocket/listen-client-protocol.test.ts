import { describe, expect, mock, test } from "bun:test";
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
  emitInterruptedStatusDelta,
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

  test("parses sync as the canonical state replay command", () => {
    const sync = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "sync",
          runtime: { agent_id: "agent-1", conversation_id: "default" },
        }),
      ),
    );
    expect(sync?.type).toBe("sync");
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

describe("listen-client permission mode scope keys", () => {
  test("falls back from legacy default key and migrates to agent-scoped key", () => {
    const listener = __listenClientTestUtils.createListenerRuntime();

    // Simulate a pre-existing/legacy persisted entry without agent binding.
    listener.permissionModeByConversation.set(
      "agent:__unknown__::conversation:default",
      {
        mode: "acceptEdits",
        planFilePath: null,
        modeBeforePlan: null,
      },
    );

    const status = __listenClientTestUtils.buildDeviceStatus(listener, {
      agent_id: "agent-123",
      conversation_id: "default",
    });

    expect(status.current_permission_mode).toBe("acceptEdits");
    expect(
      listener.permissionModeByConversation.has(
        "agent:agent-123::conversation:default",
      ),
    ).toBe(true);
    expect(
      listener.permissionModeByConversation.has(
        "agent:__unknown__::conversation:default",
      ),
    ).toBe(false);
  });
});

describe("listen-client approval resolver wiring", () => {
  test("resolved approvals restore WAITING_ON_INPUT instead of faking processing", () => {
    const runtime = __listenClientTestUtils.createRuntime();
    const socket = new MockSocket(WebSocket.OPEN);
    runtime.isProcessing = true;
    runtime.loopStatus = "WAITING_ON_APPROVAL";

    void requestApprovalOverWS(
      runtime,
      socket as unknown as WebSocket,
      "perm-status",
      makeControlRequest("perm-status"),
    ).catch(() => {});

    expect(runtime.loopStatus).toBe("WAITING_ON_APPROVAL");

    const resolved = resolvePendingApprovalResolver(runtime, {
      request_id: "perm-status",
      decision: { behavior: "allow" },
    });

    expect(resolved).toBe(true);
    expect(runtime.loopStatus as string).toBe("WAITING_ON_INPUT");
  });

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

  test("cleanup resets WAITING_ON_INPUT instead of restoring fake processing", async () => {
    const runtime = __listenClientTestUtils.createRuntime();
    runtime.isProcessing = true;
    runtime.loopStatus = "WAITING_ON_APPROVAL";

    const pending = new Promise<ApprovalResponseBody>((resolve, reject) => {
      runtime.pendingApprovalResolvers.set("perm-cleanup", { resolve, reject });
    });

    rejectPendingApprovalResolvers(runtime, "socket closed");

    expect(runtime.loopStatus as string).toBe("WAITING_ON_INPUT");
    await expect(pending).rejects.toThrow("socket closed");
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

describe("listen-client protocol emission", () => {
  test("does not throw when protocol emission send fails", () => {
    const runtime = __listenClientTestUtils.createRuntime();
    const socket = new MockSocket(WebSocket.OPEN);
    runtime.activeAgentId = "agent-1";
    runtime.activeConversationId = "default";
    socket.sendImpl = () => {
      throw new Error("socket send failed");
    };
    const originalConsoleError = console.error;
    console.error = () => {};

    try {
      expect(() =>
        __listenClientTestUtils.emitDeviceStatusUpdate(
          socket as unknown as WebSocket,
          runtime,
        ),
      ).not.toThrow();
      expect(socket.sentPayloads).toHaveLength(0);
    } finally {
      console.error = originalConsoleError;
    }
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

  test("registers a pending resolver until an approval response arrives", async () => {
    const runtime = __listenClientTestUtils.createRuntime();
    const socket = new MockSocket(WebSocket.OPEN);
    const requestId = "perm-send-fail";

    const pending = requestApprovalOverWS(
      runtime,
      socket as unknown as WebSocket,
      requestId,
      makeControlRequest(requestId),
    );

    expect(runtime.pendingApprovalResolvers.size).toBe(1);
    expect(
      runtime.pendingApprovalResolvers.get(requestId)?.controlRequest,
    ).toEqual(makeControlRequest(requestId));

    rejectPendingApprovalResolvers(runtime, "cleanup");
    await expect(pending).rejects.toThrow("cleanup");
    expect(runtime.pendingApprovalResolvers.size).toBe(0);
  });
});

describe("listen-client conversation-scoped protocol events", () => {
  test("queue enqueue/block updates loop status with runtime scope instead of stream_delta", async () => {
    const listener = __listenClientTestUtils.createListenerRuntime();
    const runtime = __listenClientTestUtils.getOrCreateScopedRuntime(
      listener,
      "agent-default",
      "default",
    );
    const socket = new MockSocket(WebSocket.OPEN);
    listener.socket = socket as unknown as WebSocket;

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

    // Flush microtask queue (update_queue is debounced via queueMicrotask)
    await Promise.resolve();

    const outbound = socket.sentPayloads.map((payload) =>
      JSON.parse(payload as string),
    );
    const queueUpdate = outbound.find(
      (payload) =>
        payload.type === "update_queue" &&
        payload.runtime.agent_id === "agent-default" &&
        payload.runtime.conversation_id === "default" &&
        payload.queue?.length === 1,
    );
    expect(queueUpdate).toBeDefined();
    expect(
      outbound.some(
        (payload) =>
          payload.type === "stream_delta" &&
          typeof payload.delta?.type === "string" &&
          payload.delta.type.startsWith("queue_"),
      ),
    ).toBe(false);
  });

  test("queue dequeue keeps scope through update_queue runtime envelope", async () => {
    const listener = __listenClientTestUtils.createListenerRuntime();
    const runtime = __listenClientTestUtils.getOrCreateScopedRuntime(
      listener,
      "agent-xyz",
      "conv-xyz",
    );
    const socket = new MockSocket(WebSocket.OPEN);
    listener.socket = socket as unknown as WebSocket;

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

    // Flush microtask queue (update_queue is debounced via queueMicrotask)
    await Promise.resolve();

    const outbound = socket.sentPayloads.map((payload) =>
      JSON.parse(payload as string),
    );
    // With microtask coalescing, enqueue + dequeue in same tick
    // produces a single update_queue with the final state (0 items)
    const dequeued = outbound.find(
      (payload) =>
        payload.type === "update_queue" &&
        payload.runtime.agent_id === "agent-xyz" &&
        payload.runtime.conversation_id === "conv-xyz" &&
        Array.isArray(payload.queue) &&
        payload.queue.length === 0,
    );
    expect(dequeued).toBeDefined();
  });
});

describe("listen-client v2 status builders", () => {
  test("buildLoopStatus defaults to WAITING_ON_INPUT with no active run", () => {
    const runtime = __listenClientTestUtils.createRuntime();
    const loopStatus = __listenClientTestUtils.buildLoopStatus(runtime);
    expect(loopStatus.status).toBe("WAITING_ON_INPUT");
    expect(loopStatus.active_run_ids).toEqual([]);
    // queue is now separate from loopStatus — verify via buildQueueSnapshot
    const queueSnapshot = __listenClientTestUtils.buildQueueSnapshot(runtime);
    expect(queueSnapshot).toEqual([]);
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

  test("resolveRuntimeScope returns null until a real runtime is bound", () => {
    const runtime = __listenClientTestUtils.createRuntime();
    expect(__listenClientTestUtils.resolveRuntimeScope(runtime)).toBeNull();

    runtime.activeAgentId = "agent-1";
    runtime.activeConversationId = "default";
    expect(__listenClientTestUtils.resolveRuntimeScope(runtime)).toEqual({
      agent_id: "agent-1",
      conversation_id: "default",
    });
  });

  test("resolveRuntimeScope does not guess another conversation when multiple runtimes exist", () => {
    const listener = __listenClientTestUtils.createListenerRuntime();
    const runtimeA = __listenClientTestUtils.getOrCreateConversationRuntime(
      listener,
      "agent-1",
      "conv-a",
    );
    __listenClientTestUtils.getOrCreateConversationRuntime(
      listener,
      "agent-1",
      "conv-b",
    );

    runtimeA.isProcessing = true;

    expect(__listenClientTestUtils.resolveRuntimeScope(listener)).toBeNull();
  });

  test("does not emit bootstrap status updates with __unknown_agent__ runtime", () => {
    const runtime = __listenClientTestUtils.createRuntime();
    const socket = new MockSocket(WebSocket.OPEN);

    __listenClientTestUtils.emitDeviceStatusUpdate(
      socket as unknown as WebSocket,
      runtime,
    );
    __listenClientTestUtils.emitLoopStatusUpdate(
      socket as unknown as WebSocket,
      runtime,
    );

    expect(socket.sentPayloads).toHaveLength(0);

    runtime.activeAgentId = "agent-1";
    runtime.activeConversationId = "default";

    __listenClientTestUtils.emitDeviceStatusUpdate(
      socket as unknown as WebSocket,
      runtime,
    );
    __listenClientTestUtils.emitLoopStatusUpdate(
      socket as unknown as WebSocket,
      runtime,
    );

    const outbound = socket.sentPayloads.map((payload) =>
      JSON.parse(payload as string),
    );
    expect(outbound).toHaveLength(2);
    expect(outbound[0].runtime).toEqual({
      agent_id: "agent-1",
      conversation_id: "default",
    });
    expect(outbound[1].runtime).toEqual({
      agent_id: "agent-1",
      conversation_id: "default",
    });
  });

  test("sync replays device, loop, and queue state for the requested runtime", () => {
    const listener = __listenClientTestUtils.createListenerRuntime();
    const runtime = __listenClientTestUtils.getOrCreateScopedRuntime(
      listener,
      "agent-1",
      "default",
    );
    const socket = new MockSocket(WebSocket.OPEN);
    const queueInput = {
      clientMessageId: "cm-1",
      agentId: "agent-1",
      conversationId: "default",
      kind: "message" as const,
      source: "user" as const,
      content: "hello",
    } as Parameters<typeof runtime.queueRuntime.enqueue>[0];

    runtime.queueRuntime.enqueue(queueInput);

    __listenClientTestUtils.emitStateSync(
      socket as unknown as WebSocket,
      runtime,
      {
        agent_id: "agent-1",
        conversation_id: "default",
      },
    );

    const outbound = socket.sentPayloads.map((payload) =>
      JSON.parse(payload as string),
    );
    expect(outbound.map((message) => message.type)).toEqual([
      "update_device_status",
      "update_loop_status",
      "update_queue",
      "update_subagent_state",
    ]);
    expect(
      outbound.every((message) => message.runtime.agent_id === "agent-1"),
    ).toBe(true);
    expect(
      outbound.every(
        (message) => message.runtime.conversation_id === "default",
      ),
    ).toBe(true);
    expect(outbound[2].queue).toEqual([
      expect.objectContaining({
        id: "q-1",
        client_message_id: "cm-1",
        kind: "message",
      }),
    ]);
  });

  test("recovered approvals surface as pending control requests and WAITING_ON_APPROVAL", () => {
    const listener = __listenClientTestUtils.createListenerRuntime();
    const runtime = __listenClientTestUtils.getOrCreateScopedRuntime(
      listener,
      "agent-1",
      "default",
    );
    const socket = new MockSocket(WebSocket.OPEN);
    const requestId = "perm-tool-call-1";

    runtime.recoveredApprovalState = {
      agentId: "agent-1",
      conversationId: "default",
      approvalsByRequestId: new Map([
        [
          requestId,
          {
            approval: {} as never,
            controlRequest: makeControlRequest(requestId),
          },
        ],
      ]),
      pendingRequestIds: new Set([requestId]),
      responsesByRequestId: new Map(),
    };

    __listenClientTestUtils.emitStateSync(
      socket as unknown as WebSocket,
      runtime,
      {
        agent_id: "agent-1",
        conversation_id: "default",
      },
    );

    const outbound = socket.sentPayloads.map((payload) =>
      JSON.parse(payload as string),
    );
    expect(outbound[0].device_status.pending_control_requests).toEqual([
      {
        request_id: requestId,
        request: makeControlRequest(requestId).request,
      },
    ]);
    expect(outbound[1].loop_status).toEqual({
      status: "WAITING_ON_APPROVAL",
      active_run_ids: [],
    });
  });

  test("sync ignores backend recovered approvals while a live turn is already processing", async () => {
    const runtime = __listenClientTestUtils.createRuntime();
    runtime.isProcessing = true;
    runtime.loopStatus = "PROCESSING_API_RESPONSE";
    runtime.activeAgentId = "agent-1";
    runtime.activeConversationId = "default";
    runtime.recoveredApprovalState = {
      agentId: "agent-1",
      conversationId: "default",
      approvalsByRequestId: new Map([
        [
          "perm-stale",
          {
            approval: {} as never,
            controlRequest: makeControlRequest("perm-stale"),
          },
        ],
      ]),
      pendingRequestIds: new Set(["perm-stale"]),
      responsesByRequestId: new Map(),
    };

    await __listenClientTestUtils.recoverApprovalStateForSync?.(runtime, {
      agent_id: "agent-1",
      conversation_id: "default",
    });

    expect(runtime.recoveredApprovalState).toBeNull();
  });

  test("starting a live turn clears stale recovered approvals for the same scope", () => {
    const listener = __listenClientTestUtils.createListenerRuntime();
    const runtime = __listenClientTestUtils.getOrCreateScopedRuntime(
      listener,
      "agent-1",
      "default",
    );
    runtime.recoveredApprovalState = {
      agentId: "agent-1",
      conversationId: "default",
      approvalsByRequestId: new Map([
        [
          "perm-stale",
          {
            approval: {} as never,
            controlRequest: makeControlRequest("perm-stale"),
          },
        ],
      ]),
      pendingRequestIds: new Set(["perm-stale"]),
      responsesByRequestId: new Map(),
    };

    __listenClientTestUtils.clearRecoveredApprovalStateForScope(runtime, {
      agent_id: "agent-1",
      conversation_id: "default",
    });

    expect(runtime.recoveredApprovalState).toBeNull();
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

  test("scoped loop status is not suppressed just because another conversation is processing", () => {
    const listener = __listenClientTestUtils.createListenerRuntime();
    const runtimeA = __listenClientTestUtils.getOrCreateConversationRuntime(
      listener,
      "agent-1",
      "conv-a",
    );
    const runtimeB = __listenClientTestUtils.getOrCreateConversationRuntime(
      listener,
      "agent-1",
      "conv-b",
    );

    runtimeA.isProcessing = true;
    runtimeA.loopStatus = "PROCESSING_API_RESPONSE";
    runtimeB.loopStatus = "WAITING_ON_APPROVAL";

    expect(
      __listenClientTestUtils.buildLoopStatus(listener, {
        agent_id: "agent-1",
        conversation_id: "conv-b",
      }),
    ).toEqual({
      status: "WAITING_ON_APPROVAL",
      active_run_ids: [],
    });
  });

  test("scoped queue snapshots are not suppressed just because another conversation is processing", () => {
    const listener = __listenClientTestUtils.createListenerRuntime();
    const runtimeA = __listenClientTestUtils.getOrCreateScopedRuntime(
      listener,
      "agent-1",
      "conv-a",
    );
    const runtimeB = __listenClientTestUtils.getOrCreateScopedRuntime(
      listener,
      "agent-1",
      "conv-b",
    );

    runtimeA.isProcessing = true;
    runtimeA.loopStatus = "PROCESSING_API_RESPONSE";
    const queueInput = {
      kind: "message",
      source: "user",
      content: "queued b",
      clientMessageId: "cm-b",
      agentId: "agent-1",
      conversationId: "conv-b",
    } satisfies Omit<MessageQueueItem, "id" | "enqueuedAt">;
    runtimeB.queueRuntime.enqueue(queueInput);

    expect(
      __listenClientTestUtils.buildQueueSnapshot(listener, {
        agent_id: "agent-1",
        conversation_id: "conv-b",
      }),
    ).toEqual([
      expect.objectContaining({
        client_message_id: "cm-b",
        kind: "message",
      }),
    ]);
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

describe("listen-client interrupt status delta emission", () => {
  test("emits a canonical Interrupted status message", () => {
    const runtime = __listenClientTestUtils.createRuntime();
    const socket = new MockSocket(WebSocket.OPEN);

    emitInterruptedStatusDelta(socket as unknown as WebSocket, runtime, {
      runId: "run-1",
      agentId: "agent-1",
      conversationId: "default",
    });

    expect(socket.sentPayloads).toHaveLength(1);
    const payload = JSON.parse(socket.sentPayloads[0] ?? "{}");
    expect(payload.type).toBe("stream_delta");
    expect(payload.delta).toMatchObject({
      message_type: "status",
      message: "Interrupted",
      level: "warning",
      run_id: "run-1",
    });
    expect(payload.runtime).toMatchObject({
      agent_id: "agent-1",
      conversation_id: "default",
    });
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

  test("recovered approvals are stashed as denials on interrupt", () => {
    const runtime = __listenClientTestUtils.createRuntime();
    runtime.recoveredApprovalState = {
      agentId: "agent-1",
      conversationId: "conv-1",
      approvalsByRequestId: new Map([
        [
          "perm-tool-1",
          {
            approval: {
              toolCallId: "tool-1",
              toolName: "Bash",
              toolArgs: '{"command":"ls"}',
            },
            controlRequest: makeControlRequest("perm-tool-1"),
          },
        ],
        [
          "perm-tool-2",
          {
            approval: {
              toolCallId: "tool-2",
              toolName: "Bash",
              toolArgs: '{"command":"pwd"}',
            },
            controlRequest: makeControlRequest("perm-tool-2"),
          },
        ],
      ]),
      pendingRequestIds: new Set(["perm-tool-1", "perm-tool-2"]),
      responsesByRequestId: new Map(),
    };

    const stashed = __listenClientTestUtils.stashRecoveredApprovalInterrupts(
      runtime,
      runtime.recoveredApprovalState,
    );

    expect(stashed).toBe(true);
    expect(runtime.recoveredApprovalState).toBeNull();

    const consumed = __listenClientTestUtils.consumeInterruptQueue(
      runtime,
      "agent-1",
      "conv-1",
    );
    expect(consumed?.approvalMessage.approvals).toEqual([
      {
        type: "approval",
        tool_call_id: "tool-1",
        approve: false,
        reason: "User interrupted the stream",
      },
      {
        type: "approval",
        tool_call_id: "tool-2",
        approve: false,
        reason: "User interrupted the stream",
      },
    ]);
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
        message?: string;
        updated_input?: Record<string, unknown>;
      };
      expect(canUseToolResponse.behavior).toBe("allow");
      expect(canUseToolResponse.updated_input).toEqual({
        file_path: "/updated/path.ts",
        content: "new content",
      });
    }
  });

  test("approval_response with allow preserves optional comment", async () => {
    const runtime = __listenClientTestUtils.createRuntime();
    const socket = new MockSocket(WebSocket.OPEN);
    const requestId = "perm-allow-comment-test";

    const pending = requestApprovalOverWS(
      runtime,
      socket as unknown as WebSocket,
      requestId,
      makeControlRequest(requestId),
    );

    resolvePendingApprovalResolver(runtime, {
      request_id: requestId,
      decision: {
        behavior: "allow",
        message: "Ship it",
      },
    });

    const response = await pending;
    expect("decision" in response).toBe(true);
    if ("decision" in response) {
      const canUseToolResponse = response.decision as {
        behavior: string;
        message?: string;
      };
      expect(canUseToolResponse.behavior).toBe("allow");
      expect(canUseToolResponse.message).toBe("Ship it");
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
    const listener = __listenClientTestUtils.createListenerRuntime();
    const runtime = __listenClientTestUtils.getOrCreateScopedRuntime(
      listener,
      "agent-1",
      "default",
    );
    const socket = new MockSocket(WebSocket.OPEN);
    listener.socket = socket as unknown as WebSocket;
    const requestId = "perm-adapter-test";

    void requestApprovalOverWS(
      runtime,
      socket as unknown as WebSocket,
      requestId,
      makeControlRequest(requestId),
    ).catch(() => {});

    expect(socket.sentPayloads.length).toBeGreaterThanOrEqual(2);
    const outbound = socket.sentPayloads.map((payload) =>
      JSON.parse(payload as string),
    );
    const loopStatus = outbound.find(
      (payload) => payload.type === "update_loop_status",
    );
    const deviceStatus = outbound.find(
      (payload) => payload.type === "update_device_status",
    );
    expect(loopStatus).toBeDefined();
    expect(deviceStatus).toBeDefined();
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

  test("handled recovered approval responses reschedule queue pumping for the fallback scoped runtime", async () => {
    const listener = __listenClientTestUtils.createListenerRuntime();
    const targetRuntime =
      __listenClientTestUtils.getOrCreateConversationRuntime(
        listener,
        "agent-1",
        "default",
      );
    const socket = new MockSocket(WebSocket.OPEN);
    const scheduleQueuePumpMock = mock(() => {});
    const resolveRecoveredApprovalResponseMock = mock(async () => true);

    const handled = await __listenClientTestUtils.handleApprovalResponseInput(
      listener,
      {
        runtime: { agent_id: "agent-1", conversation_id: "default" },
        response: {
          request_id: "perm-recovered",
          decision: { behavior: "allow" },
        },
        socket: socket as unknown as WebSocket,
        opts: {
          onStatusChange: undefined,
          connectionId: "conn-1",
        },
        processQueuedTurn: async () => {},
      },
      {
        resolveRuntimeForApprovalRequest: () => null,
        resolvePendingApprovalResolver: () => false,
        getOrCreateScopedRuntime: () => targetRuntime,
        resolveRecoveredApprovalResponse: resolveRecoveredApprovalResponseMock,
        scheduleQueuePump: scheduleQueuePumpMock,
      },
    );

    expect(handled).toBe(true);
    expect(resolveRecoveredApprovalResponseMock).toHaveBeenCalledWith(
      targetRuntime,
      socket,
      {
        request_id: "perm-recovered",
        decision: { behavior: "allow" },
      },
      expect.any(Function),
      {
        onStatusChange: undefined,
        connectionId: "conn-1",
      },
    );
    expect(scheduleQueuePumpMock).toHaveBeenCalledWith(
      targetRuntime,
      socket,
      expect.objectContaining({ connectionId: "conn-1" }),
      expect.any(Function),
    );
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

describe("listen-client runtime metadata", () => {
  test("runtime sessionId is stable and uses listen- prefix", () => {
    const runtime = __listenClientTestUtils.createRuntime();
    expect(runtime.sessionId).toMatch(/^listen-/);
    expect(runtime.sessionId.length).toBeGreaterThan(10);
  });
});

describe("listen-client retry delta emission", () => {
  test("emits retry message text alongside structured retry metadata", () => {
    const runtime = __listenClientTestUtils.createRuntime();
    runtime.activeAgentId = "agent-1";
    runtime.activeConversationId = "default";
    const socket = new MockSocket();

    __listenClientTestUtils.emitRetryDelta(
      socket as unknown as WebSocket,
      runtime,
      {
        message: "Anthropic API is overloaded, retrying...",
        reason: "error",
        attempt: 1,
        maxAttempts: 3,
        delayMs: 1000,
        agentId: "agent-1",
        conversationId: "default",
      },
    );

    expect(socket.sentPayloads).toHaveLength(1);
    const [firstPayload] = socket.sentPayloads;
    expect(firstPayload).toBeDefined();
    const payload = JSON.parse(firstPayload as string) as {
      type: string;
      delta: Record<string, unknown>;
    };
    expect(payload.type).toBe("stream_delta");
    expect(payload.delta).toMatchObject({
      message_type: "retry",
      message: "Anthropic API is overloaded, retrying...",
      reason: "error",
      attempt: 1,
      max_attempts: 3,
      delay_ms: 1000,
    });
  });
});

describe("listen-client queue event emission", () => {
  test("queue enqueue/dequeue emits queue snapshots without loop-status jitter", async () => {
    const runtime = __listenClientTestUtils.createRuntime();
    const socket = new MockSocket();
    runtime.socket = socket as unknown as WebSocket;

    runtime.queueRuntime.enqueue({
      kind: "message",
      source: "user",
      content: "hello",
      clientMessageId: "cm-1",
      agentId: "agent-1",
      conversationId: "default",
    } as Parameters<typeof runtime.queueRuntime.enqueue>[0]);

    await Promise.resolve();

    const dequeued = runtime.queueRuntime.consumeItems(1);
    expect(dequeued).not.toBeNull();

    await Promise.resolve();

    const payloadTypes = socket.sentPayloads.map((payload) => {
      const parsed = JSON.parse(payload) as { type: string };
      return parsed.type;
    });

    expect(payloadTypes.length).toBeGreaterThan(0);
    expect(new Set(payloadTypes)).toEqual(new Set(["update_queue"]));
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

describe("listen-client approval continuation recovery disposition", () => {
  test("retries the original continuation when recovery handled nothing", () => {
    expect(
      __listenClientTestUtils.getApprovalContinuationRecoveryDisposition(null),
    ).toBe("retry");
  });

  test("treats drained recovery turns as handled", () => {
    expect(
      __listenClientTestUtils.getApprovalContinuationRecoveryDisposition({
        stopReason: "end_turn",
        lastRunId: "run-1",
        apiDurationMs: 0,
      }),
    ).toBe("handled");
  });
});

describe("listen-client approval continuation run handoff", () => {
  test("clears stale active run ids once an approval continuation is accepted", () => {
    const runtime = __listenClientTestUtils.createRuntime();
    runtime.activeRunId = "run-1";

    __listenClientTestUtils.markAwaitingAcceptedApprovalContinuationRunId(
      runtime,
      [{ type: "approval", approvals: [] }],
    );

    expect(runtime.activeRunId).toBeNull();
  });

  test("preserves active run ids for non-approval sends", () => {
    const runtime = __listenClientTestUtils.createRuntime();
    runtime.activeRunId = "run-1";

    __listenClientTestUtils.markAwaitingAcceptedApprovalContinuationRunId(
      runtime,
      [
        {
          role: "user",
          content: "hello",
        },
      ],
    );

    expect(runtime.activeRunId).toBe("run-1");
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
