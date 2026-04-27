import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import WebSocket from "ws";
import { getMemoryFilesystemRoot } from "../../agent/memoryFilesystem";
import { getGitContext } from "../../cli/helpers/gitContext";
import { getReflectionSettings } from "../../cli/helpers/memoryReminder";
import { getSubagents } from "../../cli/helpers/subagentState";
import { getSystemPromptDoctorState } from "../../cli/helpers/systemPromptWarning";
import { experimentManager } from "../../experiments/manager";
import { permissionMode } from "../../permissions/mode";
import type { DequeuedBatch } from "../../queue/queueRuntime";
import { settingsManager } from "../../settings-manager";
import {
  backgroundProcesses,
  backgroundTasks,
} from "../../tools/impl/process_manager";
import type {
  BackgroundProcessSummary,
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
import { isDebugEnabled } from "../../utils/debug";
import { SUPPORTED_REMOTE_COMMANDS } from "./commands";
import { SYSTEM_REMINDER_RE } from "./constants";
import { getConversationWorkingDirectory } from "./cwd";
import { getConversationPermissionModeState } from "./permissionMode";
import {
  getConversationRuntime,
  getPendingControlRequests,
  getRecoveredApprovalStateForScope,
  hasInterruptedCacheForScope,
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

const GIT_CONTEXT_CACHE_TTL_MS = 15_000;
const MAX_GIT_CONTEXT_CACHE_ENTRIES = 64;
const PROTOCOL_PERF_FLUSH_INTERVAL_MS = 1_000;
const PROTOCOL_PERF_ENV_VALUES = new Set(["1", "true", "yes"]);
const PROTOCOL_PERF_ENABLED = PROTOCOL_PERF_ENV_VALUES.has(
  (process.env.LETTA_LISTENER_PERF ?? "").toLowerCase(),
);
const PROTOCOL_PERF_FILE = process.env.LETTA_LISTENER_PERF_FILE?.trim() || null;

type ProtocolPerfBucket = {
  count: number;
  bytes: number;
  stringifyMs: number;
  sendMs: number;
  maxBufferedBefore: number;
  maxBufferedAfter: number;
};

const protocolPerfBuckets = new Map<string, ProtocolPerfBucket>();
let protocolPerfFlushTimer: ReturnType<typeof setTimeout> | null = null;
let protocolPerfWindowStartedAt = 0;
let protocolPerfFileDirEnsured: string | null = null;
let protocolPerfFileWarningEmitted = false;

function getProtocolPerfKey(
  message: Omit<
    WsProtocolMessage,
    "runtime" | "event_seq" | "emitted_at" | "idempotency_key"
  >,
): string {
  if (message.type === "stream_delta" && "delta" in message) {
    const delta = message.delta as { message_type?: unknown };
    return `${message.type}:${String(delta.message_type ?? "unknown")}`;
  }
  return message.type;
}

function scheduleProtocolPerfFlush(): void {
  if (protocolPerfFlushTimer) {
    return;
  }
  protocolPerfFlushTimer = setTimeout(() => {
    protocolPerfFlushTimer = null;
    flushProtocolPerfTelemetry();
  }, PROTOCOL_PERF_FLUSH_INTERVAL_MS);
  const timerWithUnref = protocolPerfFlushTimer as ReturnType<
    typeof setTimeout
  > & {
    unref?: () => void;
  };
  timerWithUnref.unref?.();
}

function recordProtocolPerfTelemetry(
  key: string,
  sample: {
    bytes: number;
    stringifyMs: number;
    sendMs: number;
    bufferedBefore: number;
    bufferedAfter: number;
  },
): void {
  if (protocolPerfWindowStartedAt === 0) {
    protocolPerfWindowStartedAt = Date.now();
  }
  const bucket = protocolPerfBuckets.get(key) ?? {
    count: 0,
    bytes: 0,
    stringifyMs: 0,
    sendMs: 0,
    maxBufferedBefore: 0,
    maxBufferedAfter: 0,
  };
  bucket.count += 1;
  bucket.bytes += sample.bytes;
  bucket.stringifyMs += sample.stringifyMs;
  bucket.sendMs += sample.sendMs;
  bucket.maxBufferedBefore = Math.max(
    bucket.maxBufferedBefore,
    sample.bufferedBefore,
  );
  bucket.maxBufferedAfter = Math.max(
    bucket.maxBufferedAfter,
    sample.bufferedAfter,
  );
  protocolPerfBuckets.set(key, bucket);
  scheduleProtocolPerfFlush();
}

function writeProtocolPerfFile(
  record: {
    ts: string;
    event: "protocol_emit";
    window_ms: number;
    totals: ProtocolPerfBucket;
    buckets: Record<
      string,
      ProtocolPerfBucket & {
        avg_bytes: number;
        avg_stringify_ms: number;
        avg_send_ms: number;
      }
    >;
  },
  fallbackLine: string,
): void {
  const filePath = PROTOCOL_PERF_FILE;
  if (!filePath) {
    console.error(fallbackLine);
    return;
  }

  try {
    const dir = dirname(filePath);
    if (protocolPerfFileDirEnsured !== dir) {
      mkdirSync(dir, { recursive: true });
      protocolPerfFileDirEnsured = dir;
    }
    appendFileSync(filePath, `${JSON.stringify(record)}\n`, {
      encoding: "utf8",
    });
  } catch (error) {
    if (!protocolPerfFileWarningEmitted) {
      protocolPerfFileWarningEmitted = true;
      console.error(
        `[Listen Perf] Failed to write LETTA_LISTENER_PERF_FILE=${filePath}`,
        error,
      );
    }
    console.error(fallbackLine);
  }
}

function flushProtocolPerfTelemetry(): void {
  if (protocolPerfBuckets.size === 0) {
    protocolPerfWindowStartedAt = 0;
    return;
  }
  const windowMs = Math.max(1, Date.now() - protocolPerfWindowStartedAt);
  const totals: ProtocolPerfBucket = {
    count: 0,
    bytes: 0,
    stringifyMs: 0,
    sendMs: 0,
    maxBufferedBefore: 0,
    maxBufferedAfter: 0,
  };
  const buckets: Record<
    string,
    ProtocolPerfBucket & {
      avg_bytes: number;
      avg_stringify_ms: number;
      avg_send_ms: number;
    }
  > = {};
  const parts = [...protocolPerfBuckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, bucket]) => {
      totals.count += bucket.count;
      totals.bytes += bucket.bytes;
      totals.stringifyMs += bucket.stringifyMs;
      totals.sendMs += bucket.sendMs;
      totals.maxBufferedBefore = Math.max(
        totals.maxBufferedBefore,
        bucket.maxBufferedBefore,
      );
      totals.maxBufferedAfter = Math.max(
        totals.maxBufferedAfter,
        bucket.maxBufferedAfter,
      );
      buckets[key] = {
        ...bucket,
        avg_bytes: bucket.count > 0 ? bucket.bytes / bucket.count : 0,
        avg_stringify_ms:
          bucket.count > 0 ? bucket.stringifyMs / bucket.count : 0,
        avg_send_ms: bucket.count > 0 ? bucket.sendMs / bucket.count : 0,
      };

      const stringifyMs = bucket.stringifyMs.toFixed(2);
      const sendMs = bucket.sendMs.toFixed(2);
      return `${key}{count=${bucket.count},bytes=${bucket.bytes},stringify_ms=${stringifyMs},send_ms=${sendMs},max_buffered_before=${bucket.maxBufferedBefore},max_buffered_after=${bucket.maxBufferedAfter}}`;
    });
  writeProtocolPerfFile(
    {
      ts: new Date().toISOString(),
      event: "protocol_emit",
      window_ms: windowMs,
      totals,
      buckets,
    },
    `[Listen Perf] protocol_emit window_ms=${windowMs} ${parts.join(" ")}`,
  );
  protocolPerfBuckets.clear();
  protocolPerfWindowStartedAt = 0;
}

const gitContextCache = new Map<
  string,
  {
    expiresAt: number;
    value: ReturnType<typeof getGitContext>;
  }
>();

function getCachedDeviceGitContext(
  cwd: string,
): ReturnType<typeof getGitContext> {
  const now = Date.now();
  const cached = gitContextCache.get(cwd);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const value = getGitContext(cwd);
  gitContextCache.set(cwd, {
    expiresAt: now + GIT_CONTEXT_CACHE_TTL_MS,
    value,
  });

  if (gitContextCache.size > MAX_GIT_CONTEXT_CACHE_ENTRIES) {
    const oldestKey = gitContextCache.keys().next().value;
    if (oldestKey) {
      gitContextCache.delete(oldestKey);
    }
  }

  return value;
}

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

export function buildBackgroundProcessSnapshot(): BackgroundProcessSummary[] {
  const bashProcesses: BackgroundProcessSummary[] = Array.from(
    backgroundProcesses.entries(),
  )
    .filter(([, proc]) => proc.status === "running")
    .map(([processId, proc]) => ({
      process_id: processId,
      kind: "bash",
      command: proc.command,
      started_at_ms: proc.startTime?.getTime() ?? null,
      status: proc.status,
      exit_code: proc.exitCode,
    }));

  const taskProcesses: BackgroundProcessSummary[] = Array.from(
    backgroundTasks.entries(),
  )
    .filter(([, task]) => task.status === "running")
    .map(([processId, task]) => ({
      process_id: processId,
      kind: "agent_task",
      task_type: task.subagentType,
      description: task.description,
      started_at_ms: task.startTime.getTime(),
      status: task.status,
      subagent_id: task.subagentId,
      ...(task.error ? { error: task.error } : {}),
    }));

  return [...bashProcesses, ...taskProcesses].sort((a, b) => {
    const aStart = a.started_at_ms ?? 0;
    const bStart = b.started_at_ms ?? 0;
    return bStart - aStart;
  });
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
    const fallbackCwd = process.cwd();
    return {
      current_connection_id: null,
      connection_name: null,
      is_online: false,
      is_processing: false,
      current_permission_mode: permissionMode.getMode(),
      current_working_directory: fallbackCwd,
      git_context: getCachedDeviceGitContext(fallbackCwd),
      letta_code_version: process.env.npm_package_version || null,
      current_toolset: null,
      current_toolset_preference: "auto",
      current_loaded_tools: [],
      current_available_skills: [],
      background_processes: buildBackgroundProcessSnapshot(),
      pending_control_requests: [],
      experiments: experimentManager.list(),
      memory_directory: null,
      should_doctor: false,
      reflection_settings: null,
      supported_commands: [...SUPPORTED_REMOTE_COMMANDS],
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
  const interruptedCacheActive = hasInterruptedCacheForScope(listener, scope);
  const resolvedCwd = getConversationWorkingDirectory(
    listener,
    scopedAgentId,
    scopedConversationId,
  );
  const reflectionSettings = (() => {
    if (!scopedAgentId) {
      return null;
    }
    try {
      return getReflectionSettings(scopedAgentId, resolvedCwd);
    } catch {
      return null;
    }
  })();
  const systemPromptDoctorState = scopedAgentId
    ? getSystemPromptDoctorState(scopedAgentId)
    : null;
  return {
    current_connection_id: listener.connectionId,
    connection_name: listener.connectionName,
    is_online: listener.socket?.readyState === WebSocket.OPEN,
    is_processing: !!conversationRuntime?.isProcessing,
    current_permission_mode: conversationPermissionModeState.mode,
    current_working_directory: resolvedCwd,
    git_context: getCachedDeviceGitContext(resolvedCwd),
    letta_code_version: process.env.npm_package_version || null,
    current_toolset:
      conversationRuntime?.currentToolset ??
      (toolsetPreference === "auto" ? null : toolsetPreference),
    current_toolset_preference:
      conversationRuntime?.currentToolsetPreference ?? toolsetPreference,
    current_loaded_tools: conversationRuntime?.currentLoadedTools ?? [],
    current_available_skills: [],
    background_processes: buildBackgroundProcessSnapshot(),
    pending_control_requests: interruptedCacheActive
      ? []
      : getPendingControlRequests(listener, scope),
    experiments: experimentManager.list(),
    memory_directory: scopedAgentId
      ? getMemoryFilesystemRoot(scopedAgentId)
      : null,
    should_doctor: systemPromptDoctorState?.should_doctor ?? false,
    supported_commands: [...SUPPORTED_REMOTE_COMMANDS],
    reflection_settings: scopedAgentId
      ? {
          agent_id: scopedAgentId,
          trigger: reflectionSettings?.trigger ?? "compaction-event",
          step_count: reflectionSettings?.stepCount ?? 25,
        }
      : null,
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
    return {
      status: "WAITING_ON_INPUT",
      active_run_ids: [],
      plan_file_path: null,
    };
  }
  const scope = getScopeForRuntime(runtime, params);
  const scopedAgentId = resolveScopedAgentId(listener, scope);
  const scopedConversationId = resolveScopedConversationId(listener, scope);
  const conversationPermissionModeState = getConversationPermissionModeState(
    listener,
    scopedAgentId,
    scopedConversationId,
  );
  const conversationRuntime = getConversationRuntime(
    listener,
    scopedAgentId,
    scopedConversationId,
  );
  const interruptedCacheActive = hasInterruptedCacheForScope(listener, scope);
  const recovered = getRecoveredApprovalStateForScope(listener, scope);
  const status = interruptedCacheActive
    ? !conversationRuntime?.isProcessing
      ? "WAITING_ON_INPUT"
      : conversationRuntime?.loopStatus === "WAITING_ON_APPROVAL"
        ? "WAITING_ON_INPUT"
        : (conversationRuntime?.loopStatus ?? "WAITING_ON_INPUT")
    : recovered &&
        recovered.pendingRequestIds.size > 0 &&
        conversationRuntime?.loopStatus === "WAITING_ON_INPUT"
      ? "WAITING_ON_APPROVAL"
      : (conversationRuntime?.loopStatus ?? "WAITING_ON_INPUT");
  return {
    status,
    active_run_ids:
      interruptedCacheActive && !conversationRuntime?.isProcessing
        ? []
        : conversationRuntime?.activeRunId
          ? [conversationRuntime.activeRunId]
          : [],
    plan_file_path:
      conversationPermissionModeState.mode === "plan"
        ? conversationPermissionModeState.planFilePath
        : null,
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
  const perfEnabled = PROTOCOL_PERF_ENABLED;
  const stringifyStartedAt = perfEnabled ? performance.now() : 0;
  let payload: string;
  try {
    payload = JSON.stringify(outbound);
    const stringifyMs = perfEnabled
      ? performance.now() - stringifyStartedAt
      : 0;
    const bufferedBefore = perfEnabled ? socket.bufferedAmount : 0;
    const sendStartedAt = perfEnabled ? performance.now() : 0;
    socket.send(payload);
    if (perfEnabled) {
      recordProtocolPerfTelemetry(getProtocolPerfKey(message), {
        bytes: Buffer.byteLength(payload),
        stringifyMs,
        sendMs: performance.now() - sendStartedAt,
        bufferedBefore,
        bufferedAfter: socket.bufferedAmount,
      });
    }
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
  if (isDebugEnabled()) {
    console.log(`[Listen V2] Emitting ${message.type} (seq=${eventSeq})`);
  }
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

  const otid =
    firstUserPayload.otid ??
    firstUserPayload.client_message_id ??
    batch.batchId;

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

function resolveSubagentScopeForSnapshot(
  runtime: RuntimeCarrier,
  scope?: {
    agent_id?: string | null;
    conversation_id?: string | null;
  },
): RuntimeScope | null {
  const listener = getListenerRuntime(runtime);
  return resolveRuntimeScope(listener, getScopeForRuntime(runtime, scope));
}

export function buildSubagentSnapshot(
  runtime: RuntimeCarrier,
  scope?: {
    agent_id?: string | null;
    conversation_id?: string | null;
  },
): SubagentSnapshot[] {
  const runtimeScope = resolveSubagentScopeForSnapshot(runtime, scope);

  return getSubagents()
    .filter((a) => {
      // Include all statuses (pending, running, completed, error) so the
      // web UI receives the final state with tool calls and agent URL
      // before the subagent is cleaned up from the store.
      if (a.silent && a.isBackground !== true) {
        return false;
      }

      if (!runtimeScope) {
        return true;
      }

      // Scope listener-mode snapshots to the parent runtime that launched
      // the subagent so active reflection/task state does not bleed across
      // other agent/conversation tabs.
      if (!a.parentAgentId || a.parentAgentId !== runtimeScope.agent_id) {
        return false;
      }
      const parentConversationId = a.parentConversationId ?? "default";
      return parentConversationId === runtimeScope.conversation_id;
    })
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
      parent_agent_id: a.parentAgentId,
      parent_conversation_id: a.parentConversationId,
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
    subagents: buildSubagentSnapshot(runtime, scope),
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
    apiError?: LettaStreamingResponse.LettaErrorMessage;
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
      ...(params.apiError ? { api_error: params.apiError } : {}),
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
