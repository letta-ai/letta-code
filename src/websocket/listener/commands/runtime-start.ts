import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import type {
  Conversation,
  ConversationCreateParams,
} from "@letta-ai/letta-client/resources/conversations/conversations";
import type WebSocket from "ws";
import { buildClientSkillsPayload } from "@/agent/client-skills";
import { getBackend } from "@/backend";
import { migratePermissionMode } from "@/permissions/mode";
import { settingsManager } from "@/settings-manager";
import type { RuntimeScope, RuntimeStartCommand } from "@/types/protocol_v2";
import { switchConversationWorkingDirectory } from "@/websocket/listener/cwd-change";
import { registerRuntimeExternalTools } from "@/websocket/listener/external-tools";
import {
  getOrCreateConversationPermissionModeStateRef,
  persistPermissionModeMapForRuntime,
} from "@/websocket/listener/permission-mode";
import { isRuntimeStartCommand } from "@/websocket/listener/protocol-inbound";
import type {
  ConversationRuntime,
  ListenerRuntime,
} from "@/websocket/listener/types";
import type {
  GetOrCreateScopedRuntime,
  RunDetachedListenerTask,
  SafeSocketSend,
} from "./types";

type ReplaySyncStateForRuntime = (
  listenerRuntime: ListenerRuntime,
  socket: WebSocket,
  scope: RuntimeScope,
  opts?: { recoverApprovals?: boolean; forceDeviceStatus?: boolean },
) => Promise<void>;

type RuntimeStartCommandContext = {
  socket: WebSocket;
  runtime: ListenerRuntime;
  safeSocketSend: SafeSocketSend;
  runDetachedListenerTask: RunDetachedListenerTask;
  getOrCreateScopedRuntime: GetOrCreateScopedRuntime;
  replaySyncStateForRuntime: ReplaySyncStateForRuntime;
};

type CreatedResources = {
  agent: boolean;
  conversation: boolean;
};

function buildDefaultConversation(agent: AgentState): Conversation {
  const now = new Date().toISOString();
  return {
    id: "default",
    agent_id: agent.id,
    archived: false,
    archived_at: null,
    created_at: now,
    updated_at: now,
    last_message_at: null,
    summary: null,
    in_context_message_ids: [],
  } as Conversation;
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function hasString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function buildRuntimeScope(
  agent: AgentState,
  conversation: Conversation,
): RuntimeScope {
  return {
    agent_id: agent.id,
    conversation_id: conversation.id,
  };
}

function sendRuntimeStartResponse(
  context: RuntimeStartCommandContext,
  parsed: RuntimeStartCommand,
  response: {
    success: boolean;
    runtime: RuntimeScope | null;
    agent: AgentState | null;
    conversation: Conversation | null;
    created: CreatedResources;
    error?: string;
  },
): boolean {
  return context.safeSocketSend(
    context.socket,
    {
      type: "runtime_start_response",
      request_id: parsed.request_id,
      ...response,
    },
    "listener_runtime_start_send_failed",
    "listener_runtime_start",
  );
}

function validateRuntimeStartShape(parsed: RuntimeStartCommand): void {
  const hasAgentId = hasString(parsed.agent_id);
  const hasCreateAgent = parsed.create_agent !== undefined;
  if (hasAgentId === hasCreateAgent) {
    throw new Error(
      "runtime_start requires exactly one of agent_id or create_agent",
    );
  }

  if (parsed.agent_id !== undefined && !hasAgentId) {
    throw new Error("runtime_start agent_id must be a non-empty string");
  }

  const hasConversationId = hasString(parsed.conversation_id);
  if (parsed.conversation_id !== undefined && !hasConversationId) {
    throw new Error("runtime_start conversation_id must be a non-empty string");
  }

  if (hasConversationId && parsed.create_conversation !== undefined) {
    throw new Error(
      "runtime_start conversation_id cannot be combined with create_conversation",
    );
  }
}

async function resolveRuntimeStartAgent(
  parsed: RuntimeStartCommand,
  created: CreatedResources,
): Promise<AgentState> {
  const backend = getBackend();
  if (parsed.create_agent) {
    const agent = await backend.createAgent(parsed.create_agent.body);
    created.agent = true;
    if (parsed.create_agent.pin_global !== false) {
      settingsManager.pinAgent(agent.id);
    }
    return agent;
  }

  return backend.retrieveAgent(parsed.agent_id as string);
}

async function resolveRuntimeStartConversation(
  parsed: RuntimeStartCommand,
  agent: AgentState,
  created: CreatedResources,
): Promise<Conversation> {
  const backend = getBackend();
  if (hasString(parsed.conversation_id)) {
    if (parsed.conversation_id === "default") {
      return buildDefaultConversation(agent);
    }
    const conversation = await backend.retrieveConversation(
      parsed.conversation_id,
    );
    if (conversation.agent_id !== agent.id) {
      throw new Error(
        `Conversation ${conversation.id} belongs to ${conversation.agent_id}, not ${agent.id}`,
      );
    }
    return conversation;
  }

  const body = {
    ...(parsed.create_conversation?.body ?? {}),
    agent_id: agent.id,
  } satisfies ConversationCreateParams;
  const conversation = await backend.createConversation(body);
  created.conversation = true;
  return conversation;
}

async function applyRuntimeStartState(
  parsed: RuntimeStartCommand,
  context: RuntimeStartCommandContext,
  scope: RuntimeScope,
  scopedRuntime: ConversationRuntime,
): Promise<void> {
  if (parsed.mode) {
    const mode = migratePermissionMode(parsed.mode);
    if (!mode) {
      throw new Error(`Unsupported permission mode: ${parsed.mode}`);
    }
    const state = getOrCreateConversationPermissionModeStateRef(
      context.runtime,
      scope.agent_id,
      scope.conversation_id,
    );
    state.mode = mode;
    persistPermissionModeMapForRuntime(context.runtime);
  }

  if (parsed.cwd !== undefined) {
    await switchConversationWorkingDirectory({
      runtime: context.runtime,
      agentId: scope.agent_id,
      conversationId: scope.conversation_id,
      workingDirectory: parsed.cwd ?? context.runtime.bootWorkingDirectory,
      emitStatus: false,
      statusRuntime: scopedRuntime,
      statusSocket: context.socket,
    });
  }
}

async function refreshRuntimeSkillSnapshot(
  scopedRuntime: ConversationRuntime,
): Promise<void> {
  try {
    const { availableSkills } = await buildClientSkillsPayload({
      agentId: scopedRuntime.agentId ?? undefined,
    });
    scopedRuntime.currentAvailableSkills = availableSkills;
  } catch {
    scopedRuntime.currentAvailableSkills = [];
  }
}

export async function handleRuntimeStartCommand(
  parsed: RuntimeStartCommand,
  context: RuntimeStartCommandContext,
): Promise<boolean> {
  const created = { agent: false, conversation: false };
  let agent: AgentState | null = null;
  let conversation: Conversation | null = null;
  let runtimeScope: RuntimeScope | null = null;
  let shouldReplayState = false;

  try {
    validateRuntimeStartShape(parsed);
    agent = await resolveRuntimeStartAgent(parsed, created);
    conversation = await resolveRuntimeStartConversation(
      parsed,
      agent,
      created,
    );
    runtimeScope = buildRuntimeScope(agent, conversation);
    const scopedRuntime = context.getOrCreateScopedRuntime(
      context.runtime,
      runtimeScope.agent_id,
      runtimeScope.conversation_id,
    );
    await applyRuntimeStartState(parsed, context, runtimeScope, scopedRuntime);
    await refreshRuntimeSkillSnapshot(scopedRuntime);
    registerRuntimeExternalTools(
      context.runtime,
      runtimeScope,
      parsed.external_tools ?? [],
    );

    const sent = sendRuntimeStartResponse(context, parsed, {
      success: true,
      runtime: runtimeScope,
      agent,
      conversation,
      created,
    });
    shouldReplayState = sent;
  } catch (error) {
    sendRuntimeStartResponse(context, parsed, {
      success: false,
      runtime: null,
      agent,
      conversation,
      created,
      error: getErrorMessage(error, "Failed to start runtime"),
    });
  }

  if (shouldReplayState && runtimeScope) {
    await context.replaySyncStateForRuntime(
      context.runtime,
      context.socket,
      runtimeScope,
      {
        recoverApprovals: parsed.recover_approvals !== false,
        forceDeviceStatus: parsed.force_device_status !== false,
      },
    );
  }

  return true;
}

export function handleRuntimeStartProtocolCommand(
  parsed: unknown,
  context: RuntimeStartCommandContext,
): boolean {
  if (!isRuntimeStartCommand(parsed)) {
    return false;
  }

  context.runDetachedListenerTask("runtime_start", async () => {
    await handleRuntimeStartCommand(parsed, context);
  });
  return true;
}
