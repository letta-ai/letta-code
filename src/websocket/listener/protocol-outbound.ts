import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import { getScopedMemoryFilesystemRoot } from "@/agent/memory-filesystem";
import { getSubagents } from "@/agent/subagent-state";
import { getGitContext } from "@/cli/helpers/git-context";
import { getReflectionSettings } from "@/cli/helpers/memory-reminder";
import { getSystemPromptDoctorState } from "@/cli/helpers/system-prompt-warning";
import { SYSTEM_REMINDER_CLOSE, SYSTEM_REMINDER_OPEN } from "@/constants";
import { experimentManager } from "@/experiments/manager";
import { permissionMode } from "@/permissions/mode";
import type { DequeuedBatch } from "@/queue/queue-runtime";
import { settingsManager } from "@/settings-manager";
import { trackBoundaryError } from "@/telemetry/error-reporting";
import type {
  DeviceStatus,
  DeviceStatusUpdateMessage,
  LoopState,
  LoopStatusUpdateMessage,
  ModCommandInfo,
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
} from "@/types/protocol_v2";
import type { QueueRemovalTransition } from "@/types/queue-update-protocol";
import { isDebugEnabled } from "@/utils/debug";
import { buildBackgroundProcessSnapshot } from "./background-process-snapshot";
import {
  nextListenerConnectionEventSeq,
  resolveListenerConnectionTargets,
  TO_SUBSCRIBERS,
} from "./connection";
import { SYSTEM_REMINDER_RE } from "./constants";
import { getConversationWorkingDirectory, getExportedCwdMap } from "./cwd";
import {
  recordDeviceStatus,
  shouldEmitDeviceStatus,
} from "./device-status-cache";
import { SUPPORTED_REMOTE_COMMANDS } from "./listener-constants";
import { listListenerModCommands } from "./mod-command-registry";
import { enqueueOutboundFrame } from "./outbound-wire";
import { getConversationPermissionModeState } from "./permission-mode";
import {
  classifyOutboundFrame,
  isStreamChannelMessage,
} from "./protocol-outbound-routing";
import {
  getConversationRuntime,
  getPendingControlRequests,
  getRecoveredApprovalStateForScope,
  hasInterruptedCacheForScope,
  safeEmitWsEvent,
} from "./runtime";
import {
  resolveRuntimeScope,
  resolveScopedAgentId,
  resolveScopedConversationId,
} from "./scope";
import { notifyStreamObservers } from "./stream-observers";
import { isListenerTransportOpen, type ListenerTransport } from "./transport";
import { buildTurnCorrelationSnapshot } from "./turn-correlation";
import type {
  ConversationRuntime,
  IncomingMessage,
  ListenerMessageRouting,
  ListenerRuntime,
} from "./types";

type RuntimeCarrier = ListenerRuntime | ConversationRuntime | null;
type PartialRuntimeScope = {
  agent_id?: string | null;
  conversation_id?: string | null;
};

const GIT_CONTEXT_CACHE_TTL_MS = 15_000;
const MAX_GIT_CONTEXT_CACHE_ENTRIES = 64;
/**
 * Frozen copy of the supported commands list. Avoids allocating it for every
 * device-status update. (LET-8948)
 */
const FROZEN_SUPPORTED_COMMANDS: string[] = [...SUPPORTED_REMOTE_COMMANDS];

/**
 * Mod-contributed commands for the device status, omitted entirely when no mods
 * register commands so the common case adds no field.
 */
function buildModCommandsField(
  listener: ListenerRuntime,
  agentId?: string | null,
): {
  mod_commands?: ModCommandInfo[];
} {
  const modCommands = listListenerModCommands(listener, agentId);
  return modCommands.length > 0 ? { mod_commands: modCommands } : {};
}
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
  scope?: PartialRuntimeScope,
): PartialRuntimeScope {
  if (runtime && "listener" in runtime) {
    return {
      agent_id: scope && "agent_id" in scope ? scope.agent_id : runtime.agentId,
      conversation_id: scope?.conversation_id ?? runtime.conversationId,
    };
  }
  return scope ?? {};
}

export function emitRuntimeStateUpdates(
  runtime: RuntimeCarrier,
  scope: PartialRuntimeScope | undefined,
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
      cwd_map: {},
      boot_working_directory: fallbackCwd,
      should_doctor: false,
      reflection_settings: null,
      supported_commands: FROZEN_SUPPORTED_COMMANDS,
    };
  }
  const scope = getScopeForRuntime(runtime, params);
  const agentId = resolveScopedAgentId(listener, scope);
  const conversationId = resolveScopedConversationId(listener, scope);
  const conversationRuntime = getConversationRuntime(
    listener,
    agentId,
    conversationId,
  );
  const toolsetPreference = (() => {
    if (!agentId) {
      return "auto" as const;
    }
    try {
      return settingsManager.getToolsetPreference(agentId, conversationId);
    } catch {
      return "auto" as const;
    }
  })();
  const conversationPermissionModeState = getConversationPermissionModeState(
    listener,
    agentId,
    conversationId,
  );
  const interruptedCacheActive = hasInterruptedCacheForScope(listener, scope);
  const resolvedCwd =
    conversationRuntime?.activeWorkingDirectory ??
    getConversationWorkingDirectory(listener, agentId, conversationId);
  const reflectionSettings = (() => {
    if (!agentId) {
      return null;
    }
    try {
      return getReflectionSettings(agentId, resolvedCwd);
    } catch {
      return null;
    }
  })();
  const systemPromptDoctorState = agentId
    ? getSystemPromptDoctorState(agentId)
    : null;
  const transport = listener.transport ?? listener.socket;
  return {
    current_connection_id: listener.connectionId,
    connection_name: listener.connectionName,
    is_online: transport ? isListenerTransportOpen(transport) : false,
    is_processing: !!conversationRuntime?.isProcessing,
    current_permission_mode: conversationPermissionModeState.mode,
    current_working_directory: resolvedCwd,
    git_context: getCachedDeviceGitContext(resolvedCwd),
    letta_code_version: process.env.npm_package_version || null,
    current_toolset:
      conversationRuntime?.currentToolset ??
      (toolsetPreference === "auto" ? null : toolsetPreference),
    current_toolset_preference:
      conversationRuntime?.currentToolset === null
        ? toolsetPreference
        : (conversationRuntime?.currentToolsetPreference ?? toolsetPreference),
    current_loaded_tools: conversationRuntime?.currentLoadedTools ?? [],
    current_available_skills: conversationRuntime?.currentAvailableSkills ?? [],
    background_processes: buildBackgroundProcessSnapshot(
      agentId,
      conversationId,
    ),
    pending_control_requests: interruptedCacheActive
      ? []
      : getPendingControlRequests(listener, scope),
    experiments: experimentManager.list(),
    memory_directory: agentId ? getScopedMemoryFilesystemRoot(agentId) : null,
    ...(params === undefined
      ? {
          cwd_map: getExportedCwdMap(listener),
          boot_working_directory: listener.bootWorkingDirectory,
        }
      : {}),
    cwd_revision: listener.workingDirectoryRevision ?? 0,
    should_doctor: systemPromptDoctorState?.should_doctor ?? false,
    supported_commands: FROZEN_SUPPORTED_COMMANDS,
    ...buildModCommandsField(listener, agentId),
    reflection_settings: agentId
      ? {
          agent_id: agentId,
          trigger: reflectionSettings?.trigger ?? "compaction-event",
          step_count: reflectionSettings?.stepCount ?? 25,
          merge: reflectionSettings?.merge ?? "auto",
          merge_instructions: reflectionSettings?.mergeInstructions ?? "",
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
      executing_tool_call_ids: [],
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
    ...buildTurnCorrelationSnapshot(
      listener,
      scopedAgentId,
      scopedConversationId,
    ),
    // Gate on the *reported* status so downgrades (interrupted cache) also
    // clear the executing set, and stale runtime state never leaks into
    // frames emitted while the loop is not executing tools.
    executing_tool_call_ids:
      status === "EXECUTING_CLIENT_SIDE_TOOL" && conversationRuntime
        ? [...conversationRuntime.turnLifecycle.executingToolCallIds]
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

type OutboundProtocolMessage = WsProtocolMessage extends infer TMessage
  ? TMessage extends WsProtocolMessage
    ? Omit<TMessage, "runtime" | "event_seq" | "emitted_at" | "idempotency_key">
    : never
  : never;

export function emitProtocolV2Message(
  socket: ListenerTransport,
  runtime: RuntimeCarrier,
  message: OutboundProtocolMessage,
  scope:
    | {
        agent_id?: string | null;
        conversation_id?: string | null;
      }
    | undefined,
  routing: ListenerMessageRouting,
): void {
  const listener = getListenerRuntime(runtime);
  const runtimeScope = resolveRuntimeScope(
    listener,
    getScopeForRuntime(runtime, scope),
  );
  if (!runtimeScope) return;
  notifyStreamObservers(listener, message, runtimeScope);
  const frameClass = classifyOutboundFrame(message);
  const targets = resolveListenerConnectionTargets({
    runtime: listener,
    origin: socket,
    scope: runtimeScope,
    routing,
    streamMessage: isStreamChannelMessage(message.type),
  });
  for (const { connection, transport: targetSocket } of targets) {
    if (!isListenerTransportOpen(targetSocket)) continue;
    enqueueOutboundFrame(targetSocket, {
      typeLabel: message.type,
      frameClass,
      ...(frameClass === "status"
        ? {
            coalesceKey: `${message.type}:${runtimeScope.agent_id ?? ""}:${runtimeScope.conversation_id ?? ""}`,
          }
        : {}),
      build: () => {
        const eventSeq = nextListenerConnectionEventSeq(connection, listener);
        if (eventSeq === null) return null;
        const outbound: WsProtocolMessage = {
          ...message,
          runtime: runtimeScope,
          event_seq: eventSeq,
          emitted_at: new Date().toISOString(),
          idempotency_key: `${message.type}:${eventSeq}:${crypto.randomUUID()}`,
        } as WsProtocolMessage;
        let payload: string;
        try {
          payload = JSON.stringify(outbound);
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
          return null;
        }
        return {
          payload,
          perfKey: getProtocolPerfKey(message),
          onSent: () => {
            if (isDebugEnabled()) {
              console.log(
                `[Listen V2] Emitting ${message.type} (seq=${eventSeq})`,
              );
            }
            safeEmitWsEvent("send", "protocol", outbound);
          },
        };
      },
      onSendError: (error) => {
        console.error(`[Listen V2] Failed to emit ${message.type}`, error);
        safeEmitWsEvent("send", "lifecycle", {
          type: "_ws_send_error",
          message_type: message.type,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    });
  }
}

export function broadcastServiceProtocolMessage(
  runtime: ListenerRuntime,
  message: WsProtocolMessage,
): void {
  const payload = JSON.stringify(message);
  for (const connection of runtime.connections.values()) {
    if (!isListenerTransportOpen(connection.writer)) continue;
    try {
      connection.writer.send(payload);
    } catch (error) {
      trackBoundaryError({
        context: "listener_service_event_broadcast",
        errorType: "listener_service_event_send_failed",
        error,
      });
    }
  }
}

export function emitDeviceStatusUpdate(
  socket: ListenerTransport,
  runtime: RuntimeCarrier,
  scope?: PartialRuntimeScope,
  routing: ListenerMessageRouting = TO_SUBSCRIBERS,
): void {
  const deviceStatus = buildDeviceStatus(runtime, scope);
  recordDeviceStatus(socket, getScopeForRuntime(runtime, scope), deviceStatus);
  const message: Omit<
    DeviceStatusUpdateMessage,
    "runtime" | "event_seq" | "emitted_at" | "idempotency_key"
  > = {
    type: "update_device_status",
    device_status: deviceStatus,
  };
  emitProtocolV2Message(socket, runtime, message, scope, routing);
}

export function emitLoopStatusUpdate(
  socket: ListenerTransport,
  runtime: RuntimeCarrier,
  scope?: {
    agent_id?: string | null;
    conversation_id?: string | null;
  },
  routing: ListenerMessageRouting = TO_SUBSCRIBERS,
): void {
  const message: Omit<
    LoopStatusUpdateMessage,
    "runtime" | "event_seq" | "emitted_at" | "idempotency_key"
  > = {
    type: "update_loop_status",
    loop_status: buildLoopStatus(runtime, scope),
  };
  emitProtocolV2Message(socket, runtime, message, scope, routing);
}

export function emitLoopStatusIfOpen(
  runtime: RuntimeCarrier,
  scope?: {
    agent_id?: string | null;
    conversation_id?: string | null;
  },
): void {
  const listener = getListenerRuntime(runtime);
  const transport = listener?.transport ?? listener?.socket;
  if (transport && isListenerTransportOpen(transport)) {
    emitLoopStatusUpdate(transport, runtime, scope);
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
  const transport = listener?.transport ?? listener?.socket;
  if (transport && isListenerTransportOpen(transport)) {
    emitDeviceStatusUpdate(transport, runtime, scope);
  }
}

export function emitQueueUpdate(
  socket: ListenerTransport,
  runtime: RuntimeCarrier,
  scope?: {
    agent_id?: string | null;
    conversation_id?: string | null;
  },
  routing: ListenerMessageRouting = TO_SUBSCRIBERS,
  removed: readonly QueueRemovalTransition[] = [],
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
    removed: [...removed],
  };
  emitProtocolV2Message(socket, runtime, message, resolvedScope, routing);
}

function isTextContentPart(
  part: unknown,
): part is { type: "text"; text: string } {
  return (
    !!part &&
    typeof part === "object" &&
    "type" in part &&
    (part as { type: unknown }).type === "text" &&
    "text" in part &&
    typeof (part as { text: unknown }).text === "string"
  );
}

export function isSystemReminderPart(part: unknown): boolean {
  if (!isTextContentPart(part)) return false;
  const trimmed = part.text.trim();
  return (
    trimmed.startsWith(SYSTEM_REMINDER_OPEN) &&
    trimmed.endsWith(SYSTEM_REMINDER_CLOSE)
  );
}

function unwrapSystemReminderText(text: string): string | null {
  const trimmed = text.trim();
  if (
    trimmed.startsWith(SYSTEM_REMINDER_OPEN) &&
    trimmed.endsWith(SYSTEM_REMINDER_CLOSE)
  ) {
    return trimmed
      .slice(SYSTEM_REMINDER_OPEN.length, -SYSTEM_REMINDER_CLOSE.length)
      .trim();
  }
  return null;
}

function formatCronPromptForDisplay(text: string): string {
  const unwrapped = unwrapSystemReminderText(text) ?? text.trim();
  const lines = unwrapped.split(/\r?\n/);
  if (lines[1]?.startsWith("Description: ")) {
    lines.splice(1, 1);
  }
  return lines.join("\n").trim();
}

function getCronPromptDisplayForText(
  text: string,
  batch: DequeuedBatch,
): string | null {
  for (const item of batch.items) {
    if (item.kind !== "cron_prompt") {
      continue;
    }
    if (text === item.text || text.trim() === item.text.trim()) {
      return formatCronPromptForDisplay(item.text);
    }
  }
  return null;
}

function replaceCronPromptsForDisplay(
  text: string,
  batch: DequeuedBatch,
): string {
  let displayText = text;
  for (const item of batch.items) {
    if (item.kind !== "cron_prompt") {
      continue;
    }
    const display = formatCronPromptForDisplay(item.text);
    if (displayText.trim() === item.text.trim()) {
      displayText = display;
      continue;
    }
    displayText = displayText.split(item.text).join(display);
  }
  return displayText;
}

export function emitDequeuedUserMessage(
  socket: ListenerTransport,
  runtime: RuntimeCarrier,
  incoming: IncomingMessage,
  batch: DequeuedBatch,
): void {
  // A mod-driven continue turn carries no real user input — suppress the
  // optimistic echo so the follow-up stays seamless (matches TUI, where the
  // continue is injected without rendering a user message).
  if (
    batch.items.length > 0 &&
    batch.items.every((item) => item.kind === "mod_continue")
  ) {
    return;
  }

  const firstUserPayload = incoming.messages.find(
    (payload): payload is MessageCreate & { client_message_id?: string } =>
      "content" in payload,
  );
  if (!firstUserPayload) return;

  const rawContent = firstUserPayload.content;
  let content: MessageCreate["content"];

  if (typeof rawContent === "string") {
    content = replaceCronPromptsForDisplay(rawContent, batch)
      .replace(SYSTEM_REMINDER_RE, "")
      .trim();
  } else if (Array.isArray(rawContent)) {
    content = rawContent.flatMap((part) => {
      if (isTextContentPart(part)) {
        const cronDisplay = getCronPromptDisplayForText(part.text, batch);
        if (cronDisplay !== null) {
          return [{ ...part, text: cronDisplay }];
        }
      }
      return isSystemReminderPart(part) ? [] : [part];
    }) as MessageCreate["content"];
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
      created_by_id: incoming.actingUserId,
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
  removed: readonly QueueRemovalTransition[] = [],
): void {
  const listener = getListenerRuntime(runtime);
  const transport = listener?.transport ?? listener?.socket;
  if (transport && isListenerTransportOpen(transport)) {
    emitQueueUpdate(transport, runtime, scope, TO_SUBSCRIBERS, removed);
  }
}

export function emitDeviceStatusUpdateIfChanged(
  socket: ListenerTransport,
  runtime: RuntimeCarrier,
  scope?: PartialRuntimeScope,
  options?: { force?: boolean },
  routing: ListenerMessageRouting = TO_SUBSCRIBERS,
): boolean {
  const resolvedScope = getScopeForRuntime(runtime, scope);
  const deviceStatus = buildDeviceStatus(runtime, resolvedScope);
  if (
    !shouldEmitDeviceStatus(socket, resolvedScope, deviceStatus, options?.force)
  ) {
    return false;
  }
  const message: Omit<
    DeviceStatusUpdateMessage,
    "runtime" | "event_seq" | "emitted_at" | "idempotency_key"
  > = {
    type: "update_device_status",
    device_status: deviceStatus,
  };
  emitProtocolV2Message(socket, runtime, message, resolvedScope, routing);
  return true;
}

export function emitStateSync(
  socket: ListenerTransport,
  runtime: RuntimeCarrier,
  scope: RuntimeScope<string | null>,
  options?: {
    forceDeviceStatus?: boolean;
    routing?: ListenerMessageRouting;
  },
): void {
  const routing = options?.routing ?? TO_SUBSCRIBERS;
  emitDeviceStatusUpdateIfChanged(
    socket,
    runtime,
    scope,
    options?.forceDeviceStatus ? { force: true } : undefined,
    routing,
  );

  emitLoopStatusUpdate(socket, runtime, scope, routing);
  emitQueueUpdate(socket, runtime, scope, routing);
  emitSubagentStateUpdate(socket, runtime, scope, routing);
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
): RuntimeScope<string | null> | null {
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
      prompt: a.prompt,
      status: a.status,
      agent_url: a.agentURL,
      conversation_id: a.conversationId ?? null,
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
  socket: ListenerTransport,
  runtime: RuntimeCarrier,
  scope?: {
    agent_id?: string | null;
    conversation_id?: string | null;
  },
  routing: ListenerMessageRouting = TO_SUBSCRIBERS,
): void {
  const message: Omit<
    SubagentStateUpdateMessage,
    "runtime" | "event_seq" | "emitted_at" | "idempotency_key"
  > = {
    type: "update_subagent_state",
    subagents: buildSubagentSnapshot(runtime, scope),
  };
  emitProtocolV2Message(socket, runtime, message, scope, routing);
}

export function emitSubagentStateIfOpen(
  runtime: RuntimeCarrier,
  scope?: {
    agent_id?: string | null;
    conversation_id?: string | null;
  },
): void {
  const listener = getListenerRuntime(runtime);
  const transport = listener?.transport ?? listener?.socket;
  if (transport && isListenerTransportOpen(transport)) {
    emitSubagentStateUpdate(transport, runtime, scope);
  }
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
    id: `lifecycle-${crypto.randomUUID()}`,
    date: new Date().toISOString(),
    message_type: messageType,
    ...(runId ? { run_id: runId } : {}),
  };
}

export function emitCanonicalMessageDelta(
  socket: ListenerTransport,
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
  socket: ListenerTransport,
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
  socket: ListenerTransport,
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
  socket: ListenerTransport,
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
  socket: ListenerTransport,
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
  socket: ListenerTransport,
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
  emitProtocolV2Message(socket, runtime, message, scope, TO_SUBSCRIBERS);
}
