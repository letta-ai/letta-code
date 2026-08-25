import type {
  AgentCreateParams,
  AgentState,
} from "@letta-ai/letta-client/resources/agents/agents";
import type {
  Conversation,
  ConversationCreateParams,
} from "@letta-ai/letta-client/resources/conversations/conversations";
import type WebSocket from "ws";
import { createAgentWithBaseToolsRecovery } from "@/agent/create";
import { DEFAULT_CREATED_AGENT_BASE_TOOLS } from "@/agent/create-agent-request";
import { type ConversationUpdateBody, getBackend } from "@/backend";
import {
  createEphemeralConversation,
  type EphemeralConversationCreateBody,
} from "@/backend/api/ephemeral-conversations";
import { migratePermissionMode } from "@/permissions/mode";
import { canonicalizeRoot } from "@/permissions/sandbox-policy";
import { resolveWorkspaceSandbox } from "@/permissions/workspace-sandbox";
import { settingsManager } from "@/settings-manager";
import type { RuntimeScope, RuntimeStartCommand } from "@/types/protocol_v2";
import { subscribeListenerConnection } from "@/websocket/listener/connection";
import { getBootWorkingDirectory } from "@/websocket/listener/cwd";
import { switchConversationWorkingDirectory } from "@/websocket/listener/cwd-change";
import { registerRuntimeExternalTools } from "@/websocket/listener/external-tools";
import {
  getOrCreateConversationPermissionModeStateRef,
  persistPermissionModeMapForRuntime,
} from "@/websocket/listener/permission-mode";
import { isRuntimeStartCommand } from "@/websocket/listener/protocol-inbound";
import { assertRuntimeWorkspaceSandboxChangeAllowed } from "@/websocket/listener/runtime-workspace-sandbox";
import type {
  ConversationRuntime,
  ListenerConnectionId,
  ListenerRuntime,
} from "@/websocket/listener/types";
import type {
  GetOrCreateScopedRuntime,
  RunDetachedListenerTask,
  SafeSocketSend,
} from "./types";

type RuntimeStartScope = RuntimeScope<string | null>;

type ReplaySyncStateForRuntime = (
  listenerRuntime: ListenerRuntime,
  socket: WebSocket,
  scope: RuntimeStartScope,
  opts?: { recoverApprovals?: boolean; forceDeviceStatus?: boolean },
) => Promise<void>;

type RuntimeStartCommandContext = {
  socket: WebSocket;
  connectionId: ListenerConnectionId;
  runtime: ListenerRuntime;
  safeSocketSend: SafeSocketSend;
  runDetachedListenerTask: RunDetachedListenerTask;
  getOrCreateScopedRuntime: GetOrCreateScopedRuntime;
  replaySyncStateForRuntime: ReplaySyncStateForRuntime;
  createEphemeralConversation?: typeof createEphemeralConversation;
  retrieveConversation?: (conversationId: string) => Promise<Conversation>;
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
  agent: AgentState | null,
  conversation: Conversation,
): RuntimeStartScope {
  return {
    agent_id: agent?.id ?? null,
    conversation_id: conversation.id,
  };
}

function sendRuntimeStartResponse(
  context: RuntimeStartCommandContext,
  parsed: RuntimeStartCommand,
  response: {
    success: boolean;
    runtime: RuntimeStartScope | null;
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
  const hasConversationId = hasString(parsed.conversation_id);
  const hasCreateConversation = parsed.create_conversation !== undefined;

  if (parsed.agent_id !== undefined && !hasAgentId) {
    throw new Error("runtime_start agent_id must be a non-empty string");
  }
  if (parsed.conversation_id !== undefined && !hasConversationId) {
    throw new Error("runtime_start conversation_id must be a non-empty string");
  }
  if (hasAgentId && hasCreateAgent) {
    throw new Error(
      "runtime_start agent_id cannot be combined with create_agent",
    );
  }
  if (
    !hasAgentId &&
    !hasCreateAgent &&
    !hasConversationId &&
    !hasCreateConversation
  ) {
    throw new Error("runtime_start requires an agent or conversation");
  }
  if (hasConversationId && hasCreateConversation) {
    throw new Error(
      "runtime_start conversation_id cannot be combined with create_conversation",
    );
  }
}

/**
 * Match the CLI's own created-agent defaults: when the client does not
 * specify server-side tools, attach the harness default set and disable the
 * Letta agent type's base tools/rules so server defaults never leak in.
 */
export function applyCreatedAgentServerToolDefaults(
  body: AgentCreateParams,
): AgentCreateParams {
  if (
    body.tools !== undefined ||
    body.include_base_tools !== undefined ||
    body.include_base_tool_rules !== undefined
  ) {
    return body;
  }
  return {
    ...body,
    tools: [...DEFAULT_CREATED_AGENT_BASE_TOOLS],
    include_base_tools: false,
    include_base_tool_rules: false,
  };
}

async function resolveRuntimeStartAgent(
  parsed: RuntimeStartCommand,
  created: CreatedResources,
): Promise<AgentState | null> {
  if (!parsed.create_agent && !hasString(parsed.agent_id)) return null;

  const backend = getBackend();
  if (parsed.create_agent) {
    const withMemfs = parsed.create_agent.memfs !== false;
    const { prepareRawCreateAgentBodyForMemfs, enableMemfsIfCloud } =
      await import("@/agent/memory-filesystem");
    const requestedBody = applyCreatedAgentServerToolDefaults(
      parsed.create_agent.body,
    );
    const appliedHarnessToolDefaults =
      requestedBody !== parsed.create_agent.body;
    const body = withMemfs
      ? await prepareRawCreateAgentBodyForMemfs(requestedBody)
      : requestedBody;
    const agent = appliedHarnessToolDefaults
      ? await createAgentWithBaseToolsRecovery(
          (tools) => backend.createAgent({ ...body, tools }),
          [...DEFAULT_CREATED_AGENT_BASE_TOOLS],
        )
      : await backend.createAgent(body);
    if (withMemfs) {
      // Finish memfs setup (settings, repo clone, legacy tool detach) without
      // blocking runtime start. The tag is already stamped at creation, so
      // lazy sync paths can complete this even if the process dies here.
      void enableMemfsIfCloud(agent.id);
    } else {
      // Worker-style agent: no memfs of its own; a memory scope may be
      // provided per session (MEMORY_DIR + LETTA_MEMORY_DIR_EXPLICIT).
      settingsManager.setMemfsEnabled(agent.id, false);
    }
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
  agent: AgentState | null,
  created: CreatedResources,
  createEphemeral: typeof createEphemeralConversation,
  retrieveConversation: (conversationId: string) => Promise<Conversation>,
): Promise<Conversation> {
  const backend = getBackend();
  if (hasString(parsed.conversation_id)) {
    if (parsed.conversation_id === "default") {
      if (!agent) {
        throw new Error("Agent-free runtimes require a persisted conversation");
      }
      return buildDefaultConversation(agent);
    }
    const conversation = await retrieveConversation(parsed.conversation_id);
    const conversationAgentId = conversation.agent_id ?? null;
    if (conversationAgentId !== (agent?.id ?? null)) {
      throw new Error(
        agent
          ? `Conversation ${conversation.id} belongs to ${conversationAgentId}, not ${agent.id}`
          : `Conversation ${conversation.id} is agent-backed; provide agent_id`,
      );
    }
    return conversation;
  }

  if (!agent) {
    const body = parsed.create_conversation?.body as
      | EphemeralConversationCreateBody
      | undefined;
    if (!body || !hasString(body.model) || typeof body.system !== "string") {
      throw new Error(
        "Agent-free conversation creation requires body.model and body.system",
      );
    }
    const conversation = await createEphemeral(body);
    created.conversation = true;
    return conversation as unknown as Conversation;
  }
  const conversation = await backend.createConversation({
    ...(parsed.create_conversation?.body ?? {}),
    agent_id: agent.id,
  } as ConversationCreateParams);
  created.conversation = true;
  return conversation;
}

const LEGACY_SUMMARY_PREFIX_BY_SOURCE_TAG: Readonly<Record<string, string>> = {
  "channel:discord": "discord",
  "channel:slack": "slack",
  "channel:telegram": "telegram",
  "origin:schedule": "schedule",
};

function removeMatchingSourcePrefix(
  summary: string | null | undefined,
  sourceTags: readonly string[],
): string | null | undefined {
  if (typeof summary !== "string") return summary;

  const match = summary.match(/^\s*\[([^\]]+)\]\s*/);
  if (!match) return summary;

  const prefix = match[1]?.trim().toLowerCase();
  const matchesSourceTag = sourceTags.some(
    (tag) => LEGACY_SUMMARY_PREFIX_BY_SOURCE_TAG[tag] === prefix,
  );
  return matchesSourceTag ? summary.slice(match[0].length) : summary;
}

async function applyRuntimeStartConversationSourceTags(
  parsed: RuntimeStartCommand,
  conversation: Conversation,
): Promise<Conversation> {
  const sourceTags = parsed.conversation_source_tags;
  if (conversation.id === "default" || !sourceTags?.length) {
    return conversation;
  }

  const currentTags = Reflect.get(conversation, "tags");
  const existingTags = Array.isArray(currentTags)
    ? currentTags.filter((tag): tag is string => typeof tag === "string")
    : [];
  const missingTags = sourceTags.filter((tag) => !existingTags.includes(tag));
  const summary = removeMatchingSourcePrefix(conversation.summary, sourceTags);
  const summaryChanged = summary !== conversation.summary;
  if (missingTags.length === 0 && !summaryChanged) {
    return conversation;
  }

  return getBackend().updateConversation(conversation.id, {
    ...(missingTags.length > 0
      ? { tags: [...new Set([...existingTags, ...missingTags])] }
      : {}),
    ...(summaryChanged ? { summary } : {}),
  } as ConversationUpdateBody);
}

async function applyRuntimeStartState(
  parsed: RuntimeStartCommand,
  context: RuntimeStartCommandContext,
  scope: RuntimeStartScope,
  scopedRuntime: ConversationRuntime,
): Promise<void> {
  const workspaceSandbox = parsed.workspace_sandbox
    ? resolveWorkspaceSandbox({
        root: parsed.workspace_sandbox.root,
        isolationRoot: parsed.workspace_sandbox.isolation_root,
      })
    : undefined;
  const requestedWorkingDirectory =
    parsed.cwd ??
    workspaceSandbox?.root ??
    getBootWorkingDirectory(context.runtime);
  const canonicalWorkingDirectory = canonicalizeRoot(requestedWorkingDirectory);
  if (
    workspaceSandbox &&
    canonicalWorkingDirectory !== workspaceSandbox.root &&
    !canonicalWorkingDirectory.startsWith(`${workspaceSandbox.root}/`)
  ) {
    throw new Error(
      "runtime_start cwd must be inside the workspace sandbox root",
    );
  }
  assertRuntimeWorkspaceSandboxChangeAllowed(
    context.runtime,
    scopedRuntime,
    workspaceSandbox,
  );
  scopedRuntime.workspaceSandbox = workspaceSandbox;

  if (
    parsed.skill_sources === undefined &&
    parsed.preserve_skill_sources !== true
  ) {
    scopedRuntime.skillSources = undefined;
    context.runtime.skillSourcesByConversation.delete(scopedRuntime.key);
  } else if (parsed.skill_sources !== undefined) {
    const skillSources = [...new Set(parsed.skill_sources)];
    scopedRuntime.skillSources = skillSources;
    context.runtime.skillSourcesByConversation.set(
      scopedRuntime.key,
      skillSources,
    );
  }

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

  if (parsed.cwd !== undefined || workspaceSandbox) {
    await switchConversationWorkingDirectory({
      runtime: context.runtime,
      agentId: scope.agent_id,
      conversationId: scope.conversation_id,
      workingDirectory: requestedWorkingDirectory,
      emitStatus: false,
      statusRuntime: scopedRuntime,
      statusSocket: context.socket,
    });
  }
}

export async function handleRuntimeStartCommand(
  parsed: RuntimeStartCommand,
  context: RuntimeStartCommandContext,
): Promise<boolean> {
  const created = { agent: false, conversation: false };
  let agent: AgentState | null = null;
  let conversation: Conversation | null = null;
  let runtimeScope: RuntimeStartScope | null = null;
  let shouldReplayState = false;

  try {
    validateRuntimeStartShape(parsed);
    agent = await resolveRuntimeStartAgent(parsed, created);
    conversation = await resolveRuntimeStartConversation(
      parsed,
      agent,
      created,
      context.createEphemeralConversation ?? createEphemeralConversation,
      context.retrieveConversation ??
        ((id) => getBackend().retrieveConversation(id)),
    );
    conversation = await applyRuntimeStartConversationSourceTags(
      parsed,
      conversation,
    );
    runtimeScope = buildRuntimeScope(agent, conversation);
    const { connectionId } = context;
    const assertConnectionOpen = () => {
      if (
        context.runtime.connections.size > 0 &&
        (!context.runtime.connections.has(connectionId) ||
          context.runtime.connections.get(connectionId)?.cancellation.signal
            .aborted)
      ) {
        throw new Error("App-server connection closed during runtime start");
      }
    };
    assertConnectionOpen();
    const scopedRuntime = context.getOrCreateScopedRuntime(
      context.runtime,
      runtimeScope.agent_id,
      runtimeScope.conversation_id,
    );
    await applyRuntimeStartState(parsed, context, runtimeScope, scopedRuntime);
    assertConnectionOpen();
    subscribeListenerConnection(context.runtime, connectionId, runtimeScope);
    registerRuntimeExternalTools(
      context.runtime,
      connectionId,
      runtimeScope,
      parsed.external_tools ?? [],
    );

    if (parsed.wait_for_replay) {
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
    const sent = sendRuntimeStartResponse(context, parsed, {
      success: true,
      runtime: runtimeScope,
      agent,
      conversation,
      created,
    });
    shouldReplayState = sent && !parsed.wait_for_replay;
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
