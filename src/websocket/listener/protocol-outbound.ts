import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import WebSocket from "ws";
import { permissionMode } from "../../permissions/mode";
import type { DequeuedBatch } from "../../queue/queueRuntime";
import { settingsManager } from "../../settings-manager";
import { getToolNames } from "../../tools/manager";
import type {
  DeviceStatus,
  DeviceStatusUpdateMessage,
  LoopState,
  LoopStatus,
  LoopStatusUpdateMessage,
  QueueMessage,
  QueueUpdateMessage,
  RetryMessage,
  RuntimeScope,
  StatusMessage,
  StopReasonType,
  StreamDelta,
  StreamDeltaMessage,
  WsProtocolMessage,
} from "../../types/protocol_v2";
import { SYSTEM_REMINDER_RE } from "./constants";
import { getConversationWorkingDirectory } from "./cwd";
import {
  getPendingControlRequests,
  getRecoveredApprovalStateForScope,
  nextEventSeq,
  safeEmitWsEvent,
} from "./runtime";
import {
  isScopeCurrentlyActive,
  resolveRuntimeScope,
  resolveScopedAgentId,
  resolveScopedConversationId,
} from "./scope";
import type { IncomingMessage, ListenerRuntime } from "./types";

export function emitRuntimeStateUpdates(
  runtime: ListenerRuntime,
  scope?: {
    agent_id?: string | null;
    conversation_id?: string | null;
  },
): void {
  emitLoopStatusIfOpen(runtime, scope);
  emitDeviceStatusIfOpen(runtime, scope);
}

export function buildDeviceStatus(
  runtime: ListenerRuntime,
  params?: {
    agent_id?: string | null;
    conversation_id?: string | null;
  },
): DeviceStatus {
  const scopedAgentId = resolveScopedAgentId(runtime, params);
  const scopedConversationId = resolveScopedConversationId(runtime, params);
  const scopeActive = isScopeCurrentlyActive(
    runtime,
    scopedAgentId,
    scopedConversationId,
  );
  const toolsetPreference = (() => {
    if (!scopedAgentId) {
      return "auto" as const;
    }
    try {
      return settingsManager.getToolsetPreference(scopedAgentId);
    } catch {
      return "auto" as const;
    }
  })();
  return {
    current_connection_id: runtime.connectionId,
    connection_name: runtime.connectionName,
    is_online: runtime.socket?.readyState === WebSocket.OPEN,
    is_processing: scopeActive && runtime.isProcessing,
    current_permission_mode: permissionMode.getMode(),
    current_working_directory: getConversationWorkingDirectory(
      runtime,
      scopedAgentId,
      scopedConversationId,
    ),
    letta_code_version: process.env.npm_package_version || null,
    current_toolset: toolsetPreference === "auto" ? null : toolsetPreference,
    current_toolset_preference: toolsetPreference,
    current_loaded_tools: getToolNames(),
    current_available_skills: [],
    background_processes: [],
    pending_control_requests: getPendingControlRequests(runtime, params),
  };
}

export function buildLoopStatus(
  runtime: ListenerRuntime,
  params?: {
    agent_id?: string | null;
    conversation_id?: string | null;
  },
): LoopState {
  const scopedAgentId = resolveScopedAgentId(runtime, params);
  const scopedConversationId = resolveScopedConversationId(runtime, params);
  const scopeActive = isScopeCurrentlyActive(
    runtime,
    scopedAgentId,
    scopedConversationId,
  );

  if (!scopeActive) {
    return { status: "WAITING_ON_INPUT", active_run_ids: [] };
  }

  const recovered = getRecoveredApprovalStateForScope(runtime, params);
  const status =
    recovered &&
    recovered.pendingRequestIds.size > 0 &&
    runtime.loopStatus === "WAITING_ON_INPUT"
      ? "WAITING_ON_APPROVAL"
      : runtime.loopStatus;
  return {
    status,
    active_run_ids: runtime.activeRunId ? [runtime.activeRunId] : [],
  };
}

export function buildQueueSnapshot(runtime: ListenerRuntime): QueueMessage[] {
  return runtime.queueRuntime.items.map((item) => ({
    id: item.id,
    client_message_id: item.clientMessageId ?? `cm-${item.id}`,
    kind: item.kind,
    source: item.source,
    content: item.kind === "message" ? item.content : item.text,
    enqueued_at: new Date(item.enqueuedAt).toISOString(),
  }));
}

export function setLoopStatus(
  runtime: ListenerRuntime,
  status: LoopStatus,
  scope?: {
    agent_id?: string | null;
    conversation_id?: string | null;
  },
): void {
  if (runtime.loopStatus === status) {
    return;
  }
  runtime.loopStatus = status;
  emitLoopStatusIfOpen(runtime, scope);
}

export function emitProtocolV2Message(
  socket: WebSocket,
  runtime: ListenerRuntime | null,
  message: Omit<
    WsProtocolMessage,
    "runtime" | "event_seq" | "emitted_at" | "idempotency_key"
  >,
  scope?: {
    agent_id?: string | null;
    conversation_id?: string | null;
  },
): void {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }
  const runtimeScope = resolveRuntimeScope(runtime, scope);
  if (!runtimeScope) {
    return;
  }
  const eventSeq = nextEventSeq(runtime);
  if (eventSeq === null) {
    return;
  }
  const outbound: WsProtocolMessage = {
    ...message,
    runtime: runtimeScope,
    event_seq: eventSeq,
    emitted_at: new Date().toISOString(),
    idempotency_key: `${message.type}:${eventSeq}:${crypto.randomUUID()}`,
  } as WsProtocolMessage;
  try {
    socket.send(JSON.stringify(outbound));
  } catch (error) {
    console.error(
      `[Listen V2] Failed to emit ${message.type} (seq=${eventSeq})`,
      error,
    );
    safeEmitWsEvent("send", "lifecycle", {
      type: "_ws_send_error",
      message_type: message.type,
      event_seq: eventSeq,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  console.log(`[Listen V2] Emitting ${message.type} (seq=${eventSeq})`);
  safeEmitWsEvent("send", "protocol", outbound);
}

export function emitDeviceStatusUpdate(
  socket: WebSocket,
  runtime: ListenerRuntime,
  scope?: {
    agent_id?: string | null;
    conversation_id?: string | null;
  },
): void {
  const message: Omit<
    DeviceStatusUpdateMessage,
    "runtime" | "event_seq" | "emitted_at" | "idempotency_key"
  > = {
    type: "update_device_status",
    device_status: buildDeviceStatus(runtime, scope),
  };
  emitProtocolV2Message(socket, runtime, message, scope);
}

export function emitLoopStatusUpdate(
  socket: WebSocket,
  runtime: ListenerRuntime,
  scope?: {
    agent_id?: string | null;
    conversation_id?: string | null;
  },
): void {
  const message: Omit<
    LoopStatusUpdateMessage,
    "runtime" | "event_seq" | "emitted_at" | "idempotency_key"
  > = {
    type: "update_loop_status",
    loop_status: buildLoopStatus(runtime, scope),
  };
  emitProtocolV2Message(socket, runtime, message, scope);
}

export function emitLoopStatusIfOpen(
  runtime: ListenerRuntime,
  scope?: {
    agent_id?: string | null;
    conversation_id?: string | null;
  },
): void {
  if (runtime.socket?.readyState === WebSocket.OPEN) {
    emitLoopStatusUpdate(runtime.socket, runtime, scope);
  }
}

export function emitDeviceStatusIfOpen(
  runtime: ListenerRuntime,
  scope?: {
    agent_id?: string | null;
    conversation_id?: string | null;
  },
): void {
  if (runtime.socket?.readyState === WebSocket.OPEN) {
    emitDeviceStatusUpdate(runtime.socket, runtime, scope);
  }
}

export function emitQueueUpdate(
  socket: WebSocket,
  runtime: ListenerRuntime,
  scope?: {
    agent_id?: string | null;
    conversation_id?: string | null;
  },
): void {
  const scopedAgentId = resolveScopedAgentId(runtime, scope);
  const scopedConversationId = resolveScopedConversationId(runtime, scope);
  const scopeActive = isScopeCurrentlyActive(
    runtime,
    scopedAgentId,
    scopedConversationId,
  );

  const message: Omit<
    QueueUpdateMessage,
    "runtime" | "event_seq" | "emitted_at" | "idempotency_key"
  > = {
    type: "update_queue",
    queue: scopeActive ? buildQueueSnapshot(runtime) : [],
  };
  emitProtocolV2Message(socket, runtime, message, scope);
}

export function isSystemReminderPart(part: unknown): boolean {
  if (!part || typeof part !== "object") return false;
  if (!("type" in part) || (part as { type: string }).type !== "text") {
    return false;
  }
  if (
    !("text" in part) ||
    typeof (part as { text: string }).text !== "string"
  ) {
    return false;
  }
  const trimmed = (part as { text: string }).text.trim();
  return (
    trimmed.startsWith("<system-reminder>") &&
    trimmed.endsWith("</system-reminder>")
  );
}

export function emitDequeuedUserMessage(
  socket: WebSocket,
  runtime: ListenerRuntime,
  incoming: IncomingMessage,
  batch: DequeuedBatch,
): void {
  const firstUserPayload = incoming.messages.find(
    (payload): payload is MessageCreate & { client_message_id?: string } =>
      "content" in payload,
  );
  if (!firstUserPayload) return;

  const rawContent = firstUserPayload.content;
  let content: MessageCreate["content"];

  if (typeof rawContent === "string") {
    content = rawContent.replace(SYSTEM_REMINDER_RE, "").trim();
  } else if (Array.isArray(rawContent)) {
    content = rawContent.filter((part) => !isSystemReminderPart(part));
  } else {
    return;
  }

  const hasContent =
    typeof content === "string"
      ? content.length > 0
      : Array.isArray(content) && content.length > 0;
  if (!hasContent) return;

  const otid = firstUserPayload.client_message_id ?? batch.batchId;

  emitCanonicalMessageDelta(
    socket,
    runtime,
    {
      type: "message",
      id: `user-msg-${crypto.randomUUID()}`,
      date: new Date().toISOString(),
      message_type: "user_message",
      content,
      otid,
    } as StreamDelta,
    {
      agent_id: incoming.agentId,
      conversation_id: incoming.conversationId,
    },
  );
}

export function emitQueueUpdateIfOpen(
  runtime: ListenerRuntime,
  scope?: {
    agent_id?: string | null;
    conversation_id?: string | null;
  },
): void {
  if (runtime.socket?.readyState === WebSocket.OPEN) {
    emitQueueUpdate(runtime.socket, runtime, scope);
  }
}

export function emitStateSync(
  socket: WebSocket,
  runtime: ListenerRuntime,
  scope: RuntimeScope,
): void {
  emitDeviceStatusUpdate(socket, runtime, scope);
  emitLoopStatusUpdate(socket, runtime, scope);
  emitQueueUpdate(socket, runtime, scope);
}

export function scheduleQueueEmit(
  runtime: ListenerRuntime,
  scope?: {
    agent_id?: string | null;
    conversation_id?: string | null;
  },
): void {
  runtime.pendingQueueEmitScope = scope;

  if (runtime.queueEmitScheduled) return;
  runtime.queueEmitScheduled = true;

  queueMicrotask(() => {
    runtime.queueEmitScheduled = false;
    const emitScope = runtime.pendingQueueEmitScope;
    runtime.pendingQueueEmitScope = undefined;
    emitQueueUpdateIfOpen(runtime, emitScope);
  });
}

export function createLifecycleMessageBase<TMessageType extends string>(
  messageType: TMessageType,
  runId?: string | null,
): {
  id: string;
  date: string;
  message_type: TMessageType;
  run_id?: string;
} {
  return {
    id: `message-${crypto.randomUUID()}`,
    date: new Date().toISOString(),
    message_type: messageType,
    ...(runId ? { run_id: runId } : {}),
  };
}

export function emitCanonicalMessageDelta(
  socket: WebSocket,
  runtime: ListenerRuntime | null,
  delta: StreamDelta,
  scope?: {
    agent_id?: string | null;
    conversation_id?: string | null;
  },
): void {
  emitStreamDelta(socket, runtime, delta, scope);
}

export function emitLoopErrorDelta(
  socket: WebSocket,
  runtime: ListenerRuntime | null,
  params: {
    message: string;
    stopReason: StopReasonType;
    isTerminal: boolean;
    runId?: string | null;
    agentId?: string | null;
    conversationId?: string | null;
  },
): void {
  emitCanonicalMessageDelta(
    socket,
    runtime,
    {
      ...createLifecycleMessageBase("loop_error", params.runId),
      message: params.message,
      stop_reason: params.stopReason,
      is_terminal: params.isTerminal,
    } as StreamDelta,
    {
      agent_id: params.agentId,
      conversation_id: params.conversationId,
    },
  );
}

export function emitRetryDelta(
  socket: WebSocket,
  runtime: ListenerRuntime,
  params: {
    message: string;
    reason: StopReasonType;
    attempt: number;
    maxAttempts: number;
    delayMs: number;
    runId?: string | null;
    agentId?: string | null;
    conversationId?: string | null;
  },
): void {
  const delta: RetryMessage = {
    ...createLifecycleMessageBase("retry", params.runId),
    message: params.message,
    reason: params.reason,
    attempt: params.attempt,
    max_attempts: params.maxAttempts,
    delay_ms: params.delayMs,
  };
  emitCanonicalMessageDelta(socket, runtime, delta, {
    agent_id: params.agentId,
    conversation_id: params.conversationId,
  });
}

export function emitStatusDelta(
  socket: WebSocket,
  runtime: ListenerRuntime | null,
  params: {
    message: string;
    level: StatusMessage["level"];
    runId?: string | null;
    agentId?: string | null;
    conversationId?: string | null;
  },
): void {
  const delta: StatusMessage = {
    ...createLifecycleMessageBase("status", params.runId),
    message: params.message,
    level: params.level,
  };
  emitCanonicalMessageDelta(socket, runtime, delta, {
    agent_id: params.agentId,
    conversation_id: params.conversationId,
  });
}

export function emitInterruptedStatusDelta(
  socket: WebSocket,
  runtime: ListenerRuntime | null,
  params: {
    runId?: string | null;
    agentId?: string | null;
    conversationId?: string | null;
  },
): void {
  emitStatusDelta(socket, runtime, {
    message: "Interrupted",
    level: "warning",
    runId: params.runId,
    agentId: params.agentId ?? undefined,
    conversationId: params.conversationId ?? undefined,
  });
}

export function emitStreamDelta(
  socket: WebSocket,
  runtime: ListenerRuntime | null,
  delta: StreamDelta,
  scope?: {
    agent_id?: string | null;
    conversation_id?: string | null;
  },
): void {
  const message: Omit<
    StreamDeltaMessage,
    "runtime" | "event_seq" | "emitted_at" | "idempotency_key"
  > = {
    type: "stream_delta",
    delta,
  };
  emitProtocolV2Message(socket, runtime, message, scope);
}
