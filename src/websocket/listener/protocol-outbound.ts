import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import WebSocket from "ws";
import { getSubagents } from "../../cli/helpers/subagentState";
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
  SubagentSnapshot,
  SubagentStateUpdateMessage,
  WsProtocolMessage,
} from "../../types/protocol_v2";
import { SYSTEM_REMINDER_RE } from "./constants";
import { getConversationWorkingDirectory } from "./cwd";
import { getConversationPermissionModeState } from "./permissionMode";
import {
  getConversationRuntime,
  getPendingControlRequests,
  getRecoveredApprovalStateForScope,
  nextEventSeq,
  safeEmitWsEvent,
} from "./runtime";
import {
  resolveRuntimeScope,
  resolveScopedAgentId,
  resolveScopedConversationId,
} from "./scope";
import type {
  ConversationRuntime,
  IncomingMessage,
  ListenerRuntime,
} from "./types";

type RuntimeCarrier = ListenerRuntime | ConversationRuntime | null;

function getListenerRuntime(runtime: RuntimeCarrier): ListenerRuntime | null {
  if (!runtime) return null;
  return "listener" in runtime ? runtime.listener : runtime;
}

function getScopeForRuntime(
  runtime: RuntimeCarrier,
  scope?: {
    agent_id?: string | null;
    conversation_id?: string | null;
  },
): {
  agent_id?: string | null;
  conversation_id?: string | null;
} {
  if (runtime && "listener" in runtime) {
    return {
      agent_id: scope?.agent_id ?? runtime.agentId,
      conversation_id: scope?.conversation_id ?? runtime.conversationId,
    };
  }
  return scope ?? {};
}

export function emitRuntimeStateUpdates(
  runtime: RuntimeCarrier,
  scope?: {
    agent_id?: string | null;
    conversation_id?: string | null;
  },
): void {
  emitLoopStatusIfOpen(runtime, scope);
  emitDeviceStatusIfOpen(runtime, scope);
}

export function buildDeviceStatus(
  runtime: RuntimeCarrier,
  params?: {
    agent_id?: string | null;
    conversation_id?: string | null;
  },
): DeviceStatus {
  const listener = getListenerRuntime(runtime);
  if (!listener) {
    return {
      current_connection_id: null,
      connection_name: null,
      is_online: false,
      is_processing: false,
      current_permission_mode: permissionMode.getMode(),
      current_working_directory: process.cwd(),
      letta_code_version: process.env.npm_package_version || null,
      current_toolset: null,
      current_toolset_preference: "auto",
      current_loaded_tools: getToolNames(),
      current_available_skills: [],
      background_processes: [],
      pending_control_requests: [],
    };
  }
  const scope = getScopeForRuntime(runtime, params);
  const scopedAgentId = resolveScopedAgentId(listener, scope);
  const scopedConversationId = resolveScopedConversationId(listener, scope);
  const conversationRuntime = getConversationRuntime(
    listener,
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
  // Read mode from the persistent ListenerRuntime map (outlives ConversationRuntime).
  const conversationPermissionModeState = getConversationPermissionModeState(
    listener,
    scopedAgentId,
    scopedConversationId,
  );
  return {
    current_connection_id: listener.connectionId,
    connection_name: listener.connectionName,
    is_online: listener.socket?.readyState === WebSocket.OPEN,
    is_processing: !!conversationRuntime?.isProcessing,
    current_permission_mode: conversationPermissionModeState.mode,
    current_working_directory: getConversationWorkingDirectory(
      listener,
      scopedAgentId,
      scopedConversationId,
    ),
    letta_code_version: process.env.npm_package_version || null,
    current_toolset: toolsetPreference === "auto" ? null : toolsetPreference,
    current_toolset_preference: toolsetPreference,
    current_loaded_tools: getToolNames(),
    current_available_skills: [],
    background_processes: [],
    pending_control_requests: getPendingControlRequests(listener, scope),
  };
}

export function buildLoopStatus(
  runtime: RuntimeCarrier,
  params?: {
    agent_id?: string | null;
    conversation_id?: string | null;
  },
): LoopState {
  const listener = getListenerRuntime(runtime);
  if (!listener) {
    return { status: "WAITING_ON_INPUT", active_run_ids: [] };
  }
  const scope = getScopeForRuntime(runtime, params);
  const scopedAgentId = resolveScopedAgentId(listener, scope);
  const scopedConversationId = resolveScopedConversationId(listener, scope);
  const conversationRuntime = getConversationRuntime(
    listener,
    scopedAgentId,
    scopedConversationId,
  );
  const recovered = getRecoveredApprovalStateForScope(listener, scope);
  const status =
    recovered &&
    recovered.pendingRequestIds.size > 0 &&
    conversationRuntime?.loopStatus === "WAITING_ON_INPUT"
      ? "WAITING_ON_APPROVAL"
      : (conversationRuntime?.loopStatus ?? "WAITING_ON_INPUT");
  return {
    status,
    active_run_ids: conversationRuntime?.activeRunId
      ? [conversationRuntime.activeRunId]
      : [],
  };
}

export function buildQueueSnapshot(
  runtime: RuntimeCarrier,
  params?: {
    agent_id?: string | null;
    conversation_id?: string | null;
  },
): QueueMessage[] {
  const listener = getListenerRuntime(runtime);
  if (!listener) {
    return [];
  }
  const scope = getScopeForRuntime(runtime, params);
  const conversationRuntime = getConversationRuntime(
    listener,
    resolveScopedAgentId(listener, scope),
    resolveScopedConversationId(listener, scope),
  );
  return (conversationRuntime?.queueRuntime.items ?? []).map((item) => ({
    id: item.id,
    client_message_id: item.clientMessageId ?? `cm-${item.id}`,
    kind: item.kind,
    source: item.source,
    content: item.kind === "message" ? item.content : item.text,
    enqueued_at: new Date(item.enqueuedAt).toISOString(),
  }));
}

export function setLoopStatus(
  runtime: ConversationRuntime,
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
  runtime: RuntimeCarrier,
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
  const listener = getListenerRuntime(runtime);
  const runtimeScope = resolveRuntimeScope(
    listener,
    getScopeForRuntime(runtime, scope),
  );
  if (!runtimeScope) {
    return;
  }
  const eventSeq = nextEventSeq(listener);
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
  runtime: RuntimeCarrier,
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
  runtime: RuntimeCarrier,
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
  runtime: RuntimeCarrier,
  scope?: {
    agent_id?: string | null;
    conversation_id?: string | null;
  },
): void {
  const listener = getListenerRuntime(runtime);
  if (listener?.socket?.readyState === WebSocket.OPEN) {
    emitLoopStatusUpdate(listener.socket, runtime, scope);
  }
}

export function emitDeviceStatusIfOpen(
  runtime: RuntimeCarrier,
  scope?: {
    agent_id?: string | null;
    conversation_id?: string | null;
  },
): void {
  const listener = getListenerRuntime(runtime);
  if (listener?.socket?.readyState === WebSocket.OPEN) {
    emitDeviceStatusUpdate(listener.socket, runtime, scope);
  }
}

export function emitQueueUpdate(
  socket: WebSocket,
  runtime: RuntimeCarrier,
  scope?: {
    agent_id?: string | null;
    conversation_id?: string | null;
  },
): void {
  const listener = getListenerRuntime(runtime);
  if (!listener) {
    return;
  }
  const resolvedScope = getScopeForRuntime(runtime, scope);
  const message: Omit<
    QueueUpdateMessage,
    "runtime" | "event_seq" | "emitted_at" | "idempotency_key"
  > = {
    type: "update_queue",
    queue: buildQueueSnapshot(runtime, resolvedScope),
  };
  emitProtocolV2Message(socket, runtime, message, resolvedScope);
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
  runtime: RuntimeCarrier,
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
  runtime: RuntimeCarrier,
  scope?: {
    agent_id?: string | null;
    conversation_id?: string | null;
  },
): void {
  const listener = getListenerRuntime(runtime);
  if (listener?.socket?.readyState === WebSocket.OPEN) {
    emitQueueUpdate(listener.socket, runtime, scope);
  }
}

export function emitStateSync(
  socket: WebSocket,
  runtime: RuntimeCarrier,
  scope: RuntimeScope,
): void {
  emitDeviceStatusUpdate(socket, runtime, scope);
  emitLoopStatusUpdate(socket, runtime, scope);
  emitQueueUpdate(socket, runtime, scope);
  emitSubagentStateUpdate(socket, runtime, scope);
}

// ─────────────────────────────────────────────
// Subagent state
// ─────────────────────────────────────────────

export function buildSubagentSnapshot(): SubagentSnapshot[] {
  return getSubagents()
    .filter(
      (a) => !a.silent && (a.status === "pending" || a.status === "running"),
    )
    .map((a) => ({
      subagent_id: a.id,
      subagent_type: a.type,
      description: a.description,
      status: a.status,
      agent_url: a.agentURL,
      model: a.model,
      is_background: a.isBackground,
      silent: a.silent,
      tool_call_id: a.toolCallId,
      start_time: a.startTime,
      tool_calls: a.toolCalls,
      total_tokens: a.totalTokens,
      duration_ms: a.durationMs,
      error: a.error,
    }));
}

export function emitSubagentStateUpdate(
  socket: WebSocket,
  runtime: RuntimeCarrier,
  scope?: {
    agent_id?: string | null;
    conversation_id?: string | null;
  },
): void {
  const message: Omit<
    SubagentStateUpdateMessage,
    "runtime" | "event_seq" | "emitted_at" | "idempotency_key"
  > = {
    type: "update_subagent_state",
    subagents: buildSubagentSnapshot(),
  };
  emitProtocolV2Message(socket, runtime, message, scope);
}

export function emitSubagentStateIfOpen(
  runtime: RuntimeCarrier,
  scope?: {
    agent_id?: string | null;
    conversation_id?: string | null;
  },
): void {
  const listener = getListenerRuntime(runtime);
  if (listener?.socket?.readyState === WebSocket.OPEN) {
    emitSubagentStateUpdate(listener.socket, runtime, scope);
  }
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
  runtime: RuntimeCarrier,
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
  runtime: RuntimeCarrier,
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
  runtime: RuntimeCarrier,
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
  runtime: RuntimeCarrier,
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
  runtime: RuntimeCarrier,
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
  runtime: RuntimeCarrier,
  delta: StreamDelta,
  scope?: {
    agent_id?: string | null;
    conversation_id?: string | null;
  },
  subagentId?: string,
): void {
  const message: Omit<
    StreamDeltaMessage,
    "runtime" | "event_seq" | "emitted_at" | "idempotency_key"
  > = {
    type: "stream_delta",
    delta,
    ...(subagentId ? { subagent_id: subagentId } : {}),
  };
  emitProtocolV2Message(socket, runtime, message, scope);
}
