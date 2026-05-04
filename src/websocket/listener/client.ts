/**
 * WebSocket client for listen mode
 * Connects to Letta Cloud and receives messages to execute locally
 */

import type WebSocket from "ws";
import {
  clearPendingApprovalBatchIds,
  rememberPendingApprovalBatchIds,
  resolvePendingApprovalBatchId,
  resolveRecoveryBatchId,
} from "./approval";
import {
  handleChannelRegistryEvent,
  handleChannelsProtocolCommand,
  isDetachedChannelsCommand,
  setChannelsServiceLoaderOverride,
} from "./commands/channels";
import { handleCronCommand } from "./commands/cron";
import { handleListMemoryCommand } from "./commands/memory";
import {
  applyModelUpdateForRuntime,
  buildListModelsEntries,
  buildListModelsResponse,
  buildModelUpdateStatusMessage,
  resolveModelForUpdate,
} from "./commands/model-toolset";
import {
  handleExperimentCommand,
  handleReflectionSettingsCommand,
} from "./commands/settings";
import {
  handleCreateAgentCommand,
  handleSkillCommand,
} from "./commands/skills-agents";
import {
  handleAbortMessageInput,
  handleApprovalResponseInput,
  handleChangeDeviceStateInput,
  handleCwdChange,
  handleModeChange,
} from "./control-inputs";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import {
  getConversationWorkingDirectory,
  setConversationWorkingDirectory,
} from "./cwd";
import {
  consumeInterruptQueue,
  emitInterruptToolReturnMessage,
  extractInterruptToolReturns,
  getInterruptApprovalsForEmission,
  normalizeExecutionResultsForInterruptParity,
  normalizeToolReturnWireMessage,
  populateInterruptQueue,
  stashRecoveredApprovalInterrupts,
} from "./interrupts";
import {
  createRuntime,
  enqueueChannelTurn,
  recoverPendingChannelControlRequests,
  replaySyncStateForRuntime,
  runDetachedListenerTask,
  safeSocketSend,
  startConnectedListenerRuntime,
  stopRuntime,
  wireChannelIngress,
} from "./lifecycle";
import {
  buildDeviceStatus,
  buildLoopStatus,
  buildQueueSnapshot,
  emitDeviceStatusUpdate,
  emitInterruptedStatusDelta,
  emitLoopStatusUpdate,
  emitRetryDelta,
  emitStateSync,
} from "./protocol-outbound";
import {
  consumeQueuedTurn,
  normalizeInboundMessages,
  normalizeMessageContentImages,
  scheduleQueuePump,
} from "./queue";
import {
  getApprovalContinuationRecoveryDisposition,
  recoverApprovalStateForSync,
  shouldAttemptPostStopApprovalRecovery,
} from "./recovery";
import {
  clearRecoveredApprovalStateForScope,
  getListenerStatus,
  getOrCreateConversationRuntime,
  setActiveRuntime,
} from "./runtime";
import { resolveRuntimeScope } from "./scope";
import {
  markAwaitingAcceptedApprovalContinuationRunId,
  resolveStaleApprovals,
} from "./send";
import { handleIncomingMessage } from "./turn";
import type {
  ConversationRuntime,
  ListenerRuntime,
  StartListenerOptions,
} from "./types";

function asListenerRuntimeForTests(
  runtime: ListenerRuntime | ConversationRuntime,
): ListenerRuntime {
  return "listener" in runtime ? runtime.listener : runtime;
}

function createLegacyTestRuntime(): ConversationRuntime & {
  activeAgentId: string | null;
  activeConversationId: string;
  socket: WebSocket | null;
  workingDirectoryByConversation: Map<string, string>;
  permissionModeByConversation: ListenerRuntime["permissionModeByConversation"];
  reminderStateByConversation: ListenerRuntime["reminderStateByConversation"];
  contextTrackerByConversation: ListenerRuntime["contextTrackerByConversation"];
  systemPromptRecompileByConversation: ListenerRuntime["systemPromptRecompileByConversation"];
  queuedSystemPromptRecompileByConversation: ListenerRuntime["queuedSystemPromptRecompileByConversation"];
  bootWorkingDirectory: string;
  connectionId: string | null;
  connectionName: string | null;
  sessionId: string;
  eventSeqCounter: number;
  queueEmitScheduled: boolean;
  pendingQueueEmitScope?: {
    agent_id?: string | null;
    conversation_id?: string | null;
  };
  onWsEvent?: StartListenerOptions["onWsEvent"];
  reminderState: ListenerRuntime["reminderState"];
  reconnectTimeout: NodeJS.Timeout | null;
  heartbeatInterval: NodeJS.Timeout | null;
  intentionallyClosed: boolean;
  hasSuccessfulConnection: boolean;
  everConnected: boolean;
  conversationRuntimes: ListenerRuntime["conversationRuntimes"];
  approvalRuntimeKeyByRequestId: ListenerRuntime["approvalRuntimeKeyByRequestId"];
  memfsSyncedAgents: ListenerRuntime["memfsSyncedAgents"];
  secretsHydrationByAgent: ListenerRuntime["secretsHydrationByAgent"];
  secretsHydrationFreshnessByAgent: ListenerRuntime["secretsHydrationFreshnessByAgent"];
  secretsDirtyAgents: ListenerRuntime["secretsDirtyAgents"];
  agentMetadataByAgent: ListenerRuntime["agentMetadataByAgent"];
  worktreeWatcherByConversation: ListenerRuntime["worktreeWatcherByConversation"];
  lastEmittedStatus: ListenerRuntime["lastEmittedStatus"];
} {
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(listener, null, "default");
  const bridge = runtime as ConversationRuntime & {
    activeAgentId: string | null;
    activeConversationId: string;
    socket: WebSocket | null;
    workingDirectoryByConversation: Map<string, string>;
    permissionModeByConversation: ListenerRuntime["permissionModeByConversation"];
    reminderStateByConversation: ListenerRuntime["reminderStateByConversation"];
    contextTrackerByConversation: ListenerRuntime["contextTrackerByConversation"];
    systemPromptRecompileByConversation: ListenerRuntime["systemPromptRecompileByConversation"];
    queuedSystemPromptRecompileByConversation: ListenerRuntime["queuedSystemPromptRecompileByConversation"];
    bootWorkingDirectory: string;
    connectionId: string | null;
    connectionName: string | null;
    sessionId: string;
    eventSeqCounter: number;
    queueEmitScheduled: boolean;
    pendingQueueEmitScope?: {
      agent_id?: string | null;
      conversation_id?: string | null;
    };
    onWsEvent?: StartListenerOptions["onWsEvent"];
    reminderState: ListenerRuntime["reminderState"];
    reconnectTimeout: NodeJS.Timeout | null;
    heartbeatInterval: NodeJS.Timeout | null;
    intentionallyClosed: boolean;
    hasSuccessfulConnection: boolean;
    everConnected: boolean;
    conversationRuntimes: ListenerRuntime["conversationRuntimes"];
    approvalRuntimeKeyByRequestId: ListenerRuntime["approvalRuntimeKeyByRequestId"];
    memfsSyncedAgents: ListenerRuntime["memfsSyncedAgents"];
    secretsHydrationByAgent: ListenerRuntime["secretsHydrationByAgent"];
    secretsHydrationFreshnessByAgent: ListenerRuntime["secretsHydrationFreshnessByAgent"];
    secretsDirtyAgents: ListenerRuntime["secretsDirtyAgents"];
    agentMetadataByAgent: ListenerRuntime["agentMetadataByAgent"];
    worktreeWatcherByConversation: ListenerRuntime["worktreeWatcherByConversation"];
    lastEmittedStatus: ListenerRuntime["lastEmittedStatus"];
  };
  for (const [prop, getSet] of Object.entries({
    socket: {
      get: () => listener.socket,
      set: (value: WebSocket | null) => {
        listener.socket = value;
      },
    },
    workingDirectoryByConversation: {
      get: () => listener.workingDirectoryByConversation,
      set: (value: Map<string, string>) => {
        listener.workingDirectoryByConversation = value;
      },
    },
    permissionModeByConversation: {
      get: () => listener.permissionModeByConversation,
      set: (value: ListenerRuntime["permissionModeByConversation"]) => {
        listener.permissionModeByConversation = value;
      },
    },
    reminderStateByConversation: {
      get: () => listener.reminderStateByConversation,
      set: (value: ListenerRuntime["reminderStateByConversation"]) => {
        listener.reminderStateByConversation = value;
      },
    },
    contextTrackerByConversation: {
      get: () => listener.contextTrackerByConversation,
      set: (value: ListenerRuntime["contextTrackerByConversation"]) => {
        listener.contextTrackerByConversation = value;
      },
    },
    systemPromptRecompileByConversation: {
      get: () => listener.systemPromptRecompileByConversation,
      set: (value: ListenerRuntime["systemPromptRecompileByConversation"]) => {
        listener.systemPromptRecompileByConversation = value;
      },
    },
    queuedSystemPromptRecompileByConversation: {
      get: () => listener.queuedSystemPromptRecompileByConversation,
      set: (
        value: ListenerRuntime["queuedSystemPromptRecompileByConversation"],
      ) => {
        listener.queuedSystemPromptRecompileByConversation = value;
      },
    },
    bootWorkingDirectory: {
      get: () => listener.bootWorkingDirectory,
      set: (value: string) => {
        listener.bootWorkingDirectory = value;
      },
    },
    connectionId: {
      get: () => listener.connectionId,
      set: (value: string | null) => {
        listener.connectionId = value;
      },
    },
    connectionName: {
      get: () => listener.connectionName,
      set: (value: string | null) => {
        listener.connectionName = value;
      },
    },
    sessionId: {
      get: () => listener.sessionId,
      set: (value: string) => {
        listener.sessionId = value;
      },
    },
    eventSeqCounter: {
      get: () => listener.eventSeqCounter,
      set: (value: number) => {
        listener.eventSeqCounter = value;
      },
    },
    queueEmitScheduled: {
      get: () => listener.queueEmitScheduled,
      set: (value: boolean) => {
        listener.queueEmitScheduled = value;
      },
    },
    pendingQueueEmitScope: {
      get: () => listener.pendingQueueEmitScope,
      set: (
        value:
          | {
              agent_id?: string | null;
              conversation_id?: string | null;
            }
          | undefined,
      ) => {
        listener.pendingQueueEmitScope = value;
      },
    },
    onWsEvent: {
      get: () => listener.onWsEvent,
      set: (value: StartListenerOptions["onWsEvent"] | undefined) => {
        listener.onWsEvent = value;
      },
    },
    reminderState: {
      get: () => listener.reminderState,
      set: (value: ListenerRuntime["reminderState"]) => {
        listener.reminderState = value;
      },
    },
    reconnectTimeout: {
      get: () => listener.reconnectTimeout,
      set: (value: NodeJS.Timeout | null) => {
        listener.reconnectTimeout = value;
      },
    },
    heartbeatInterval: {
      get: () => listener.heartbeatInterval,
      set: (value: NodeJS.Timeout | null) => {
        listener.heartbeatInterval = value;
      },
    },
    intentionallyClosed: {
      get: () => listener.intentionallyClosed,
      set: (value: boolean) => {
        listener.intentionallyClosed = value;
      },
    },
    hasSuccessfulConnection: {
      get: () => listener.hasSuccessfulConnection,
      set: (value: boolean) => {
        listener.hasSuccessfulConnection = value;
      },
    },
    everConnected: {
      get: () => listener.everConnected,
      set: (value: boolean) => {
        listener.everConnected = value;
      },
    },
    conversationRuntimes: {
      get: () => listener.conversationRuntimes,
      set: (value: ListenerRuntime["conversationRuntimes"]) => {
        listener.conversationRuntimes = value;
      },
    },
    approvalRuntimeKeyByRequestId: {
      get: () => listener.approvalRuntimeKeyByRequestId,
      set: (value: ListenerRuntime["approvalRuntimeKeyByRequestId"]) => {
        listener.approvalRuntimeKeyByRequestId = value;
      },
    },
    memfsSyncedAgents: {
      get: () => listener.memfsSyncedAgents,
      set: (value: ListenerRuntime["memfsSyncedAgents"]) => {
        listener.memfsSyncedAgents = value;
      },
    },
    secretsHydrationByAgent: {
      get: () => listener.secretsHydrationByAgent,
      set: (value: ListenerRuntime["secretsHydrationByAgent"]) => {
        listener.secretsHydrationByAgent = value;
      },
    },
    secretsHydrationFreshnessByAgent: {
      get: () => listener.secretsHydrationFreshnessByAgent,
      set: (value: ListenerRuntime["secretsHydrationFreshnessByAgent"]) => {
        listener.secretsHydrationFreshnessByAgent = value;
      },
    },
    secretsDirtyAgents: {
      get: () => listener.secretsDirtyAgents,
      set: (value: ListenerRuntime["secretsDirtyAgents"]) => {
        listener.secretsDirtyAgents = value;
      },
    },
    agentMetadataByAgent: {
      get: () => listener.agentMetadataByAgent,
      set: (value: ListenerRuntime["agentMetadataByAgent"]) => {
        listener.agentMetadataByAgent = value;
      },
    },
    worktreeWatcherByConversation: {
      get: () => listener.worktreeWatcherByConversation,
      set: (value: ListenerRuntime["worktreeWatcherByConversation"]) => {
        listener.worktreeWatcherByConversation = value;
      },
    },
    lastEmittedStatus: {
      get: () => listener.lastEmittedStatus,
      set: (value: ListenerRuntime["lastEmittedStatus"]) => {
        listener.lastEmittedStatus = value;
      },
    },
    activeAgentId: {
      get: () => runtime.agentId,
      set: (value: string | null) => {
        runtime.agentId = value;
      },
    },
    activeConversationId: {
      get: () => runtime.conversationId,
      set: (value: string) => {
        runtime.conversationId = value;
      },
    },
  })) {
    Object.defineProperty(bridge, prop, {
      configurable: true,
      enumerable: false,
      get: getSet.get,
      set: getSet.set,
    });
  }
  return bridge;
}

export {
  rejectPendingApprovalResolvers,
  requestApprovalOverWS,
  resolvePendingApprovalResolver,
} from "./approval";
export type { StartLocalChannelListenerOptions } from "./lifecycle";
export {
  isListenerActive,
  startListenerClient,
  startLocalChannelListener,
  stopListenerClient,
} from "./lifecycle";
export { parseServerMessage } from "./protocol-inbound";
export { emitInterruptedStatusDelta } from "./protocol-outbound";

export const __listenClientTestUtils = {
  setChannelsServiceLoaderForTests: (
    loader: Parameters<typeof setChannelsServiceLoaderOverride>[0],
  ) => {
    setChannelsServiceLoaderOverride(loader);
  },
  createRuntime: createLegacyTestRuntime,
  createListenerRuntime: createRuntime,
  startConnectedListenerRuntime: startConnectedListenerRuntime,
  handleModeChange,
  getOrCreateScopedRuntime,
  buildListModelsEntries,
  buildListModelsResponse,
  buildModelUpdateStatusMessage,
  resolveModelForUpdate,
  applyModelUpdateForRuntime,
  stopRuntime: (
    runtime: ListenerRuntime | ConversationRuntime,
    suppressCallbacks: boolean,
  ) => stopRuntime(asListenerRuntimeForTests(runtime), suppressCallbacks),
  setActiveRuntime,
  getListenerStatus,
  getOrCreateConversationRuntime,
  resolveRuntimeScope,
  buildDeviceStatus,
  buildLoopStatus,
  buildQueueSnapshot,
  emitDeviceStatusUpdate,
  emitLoopStatusUpdate,
  handleCwdChange,
  getConversationWorkingDirectory,
  rememberPendingApprovalBatchIds,
  resolvePendingApprovalBatchId,
  resolveRecoveryBatchId,
  clearPendingApprovalBatchIds,
  populateInterruptQueue,
  setConversationWorkingDirectory,
  consumeInterruptQueue,
  stashRecoveredApprovalInterrupts,
  extractInterruptToolReturns,
  emitInterruptToolReturnMessage,
  emitInterruptedStatusDelta,
  emitRetryDelta,
  getInterruptApprovalsForEmission,
  normalizeToolReturnWireMessage,
  normalizeExecutionResultsForInterruptParity,
  shouldAttemptPostStopApprovalRecovery,
  getApprovalContinuationRecoveryDisposition,
  markAwaitingAcceptedApprovalContinuationRunId,
  resolveStaleApprovals,
  normalizeMessageContentImages,
  normalizeInboundMessages,
  consumeQueuedTurn,
  handleIncomingMessage,
  handleApprovalResponseInput,
  handleAbortMessageInput,
  handleChangeDeviceStateInput,
  handleCronCommand: (
    parsed: Parameters<typeof handleCronCommand>[0],
    socket: WebSocket,
  ) => handleCronCommand(parsed, socket, safeSocketSend),
  handleListMemoryCommand: (
    parsed: Parameters<typeof handleListMemoryCommand>[0],
    socket: WebSocket,
    overrides?: Parameters<typeof handleListMemoryCommand>[3],
  ) => handleListMemoryCommand(parsed, socket, safeSocketSend, overrides),
  isDetachedChannelsCommand,
  handleChannelsProtocolCommand: (
    parsed: Parameters<typeof handleChannelsProtocolCommand>[0],
    socket: WebSocket,
    runtime: ListenerRuntime,
    opts: Parameters<typeof handleChannelsProtocolCommand>[3],
    processQueuedTurn: Parameters<typeof handleChannelsProtocolCommand>[4],
  ) =>
    handleChannelsProtocolCommand(
      parsed,
      socket,
      runtime,
      opts,
      processQueuedTurn,
      runDetachedListenerTask,
      wireChannelIngress,
      safeSocketSend,
    ),
  handleChannelRegistryEvent: (
    event: Parameters<typeof handleChannelRegistryEvent>[0],
    socket: Parameters<typeof handleChannelRegistryEvent>[1],
    runtime: ListenerRuntime,
  ) => handleChannelRegistryEvent(event, socket, runtime, safeSocketSend),
  handleSkillCommand: (
    parsed: Parameters<typeof handleSkillCommand>[0],
    socket: WebSocket,
  ) => handleSkillCommand(parsed, socket, safeSocketSend),
  handleCreateAgentCommand: (
    parsed: Parameters<typeof handleCreateAgentCommand>[0],
    socket: WebSocket,
  ) => handleCreateAgentCommand(parsed, socket, safeSocketSend),
  handleExperimentCommand: (
    parsed: Parameters<typeof handleExperimentCommand>[0],
    socket: WebSocket,
    listener: ListenerRuntime,
  ) => handleExperimentCommand(parsed, socket, listener, safeSocketSend),
  handleReflectionSettingsCommand: (
    parsed: Parameters<typeof handleReflectionSettingsCommand>[0],
    socket: WebSocket,
    listener: ListenerRuntime,
  ) =>
    handleReflectionSettingsCommand(parsed, socket, listener, safeSocketSend),
  enqueueChannelTurn,
  scheduleQueuePump,
  replaySyncStateForRuntime: (
    runtime: ListenerRuntime,
    socket: WebSocket,
    scope: { agent_id: string; conversation_id: string },
    opts?: {
      recoverApprovals?: boolean;
      recoverApprovalStateForSync?: (
        runtime: ConversationRuntime,
        scope: { agent_id: string; conversation_id: string },
      ) => Promise<void>;
      scheduleWarmupsAfterSync?: (
        runtime: ListenerRuntime,
        scope: { agent_id: string; conversation_id: string },
      ) => void;
    },
  ) =>
    replaySyncStateForRuntime(runtime, socket, scope, {
      ...opts,
      scheduleWarmupsAfterSync: opts?.scheduleWarmupsAfterSync ?? (() => {}),
    }),
  recoverPendingChannelControlRequests,
  recoverApprovalStateForSync,
  clearRecoveredApprovalStateForScope: (
    runtime: ListenerRuntime | ConversationRuntime,
    scope?: {
      agent_id?: string | null;
      conversation_id?: string | null;
    },
  ) =>
    clearRecoveredApprovalStateForScope(
      asListenerRuntimeForTests(runtime),
      scope,
    ),
  emitStateSync,
};
