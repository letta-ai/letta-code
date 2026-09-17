import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import { getModelContextWindow } from "@/agent/available-models";
import { buildCreateAgentRequest } from "@/agent/create-agent-request";
import { getModelUpdateArgs } from "@/agent/model";
import type { MemoryPromptMode } from "@/agent/prompt-assets";
import { resolveAndBuildSystemPrompt } from "@/agent/system-prompt-resolution";
import { getBackend } from "@/backend";
import {
  createEphemeralConversation as createEphemeralConversationRequest,
  type EphemeralConversationCreateBody,
} from "@/backend/api/ephemeral-conversations";

export interface CreateEphemeralConversationOptions {
  model?: string;
  systemPromptPreset?: string;
  systemPromptCustom?: string;
  memoryPromptMode?: MemoryPromptMode;
  name?: string;
  isSubagent?: boolean;
  parentAgentId?: string;
}

export async function buildEphemeralConversationCreateBody(
  options: CreateEphemeralConversationOptions,
): Promise<EphemeralConversationCreateBody> {
  const system = options.systemPromptCustom
    ? options.systemPromptCustom
    : await resolveAndBuildSystemPrompt(
        options.systemPromptPreset,
        options.memoryPromptMode ?? "standard",
      );
  const request = await buildCreateAgentRequest({
    model: options.model,
    system,
    memoryPromptMode: "standard",
    enableMemfs: false,
    isSubagent: true,
    baseTools: [],
  });
  const modelSettings = options.model
    ? getModelUpdateArgs(options.model)
    : undefined;
  const contextWindow =
    (modelSettings?.context_window as number | undefined) ??
    (await getModelContextWindow(request.model));
  return {
    model: request.model,
    system: request.system,
    ...(options.parentAgentId
      ? { parent_agent_id: options.parentAgentId }
      : {}),
    ...(modelSettings ? { model_settings: modelSettings } : {}),
    ...(contextWindow ? { context_window_limit: contextWindow } : {}),
  };
}

function projectEphemeralAgent(
  conversationId: string,
  body: EphemeralConversationCreateBody,
  name?: string | null,
): AgentState {
  return {
    id: conversationId,
    name: name ?? "Ephemeral conversation",
    system: body.system,
    tools: [],
    memory: { blocks: [] },
    llm_config: {
      handle: body.model,
      model: body.model,
      context_window: body.context_window_limit ?? undefined,
      model_settings: body.model_settings ?? {},
    },
    model_settings: body.model_settings ?? {},
    message_buffer_autoclear: false,
  } as unknown as AgentState;
}

// Execution-only projection: the server owns the persisted system message and
// fork snapshot. Never rebuild it from today's prompt presets on resume.
export function projectResumedEphemeralConversation(conversation: {
  id: string;
  agent_id?: string | null;
  name?: string | null;
  model?: string | null;
  model_settings?: unknown;
  context_window_limit?: number | null;
}): AgentState {
  if (conversation.agent_id !== null || !conversation.model) {
    throw new Error(
      "Expected an agent-free conversation with a persisted model",
    );
  }
  return projectEphemeralAgent(
    conversation.id,
    {
      model: conversation.model,
      system: "",
      model_settings: (conversation.model_settings ?? {}) as Record<
        string,
        unknown
      >,
      context_window_limit: conversation.context_window_limit,
    },
    conversation.name,
  );
}

export async function createEphemeralConversation(
  options: CreateEphemeralConversationOptions,
): Promise<{ agent: AgentState; conversationId: string }> {
  const body = await buildEphemeralConversationCreateBody(options);
  const conversation = await createEphemeralConversationRequest(body, {
    ...(options.name !== undefined ? { name: options.name } : {}),
    ...(options.isSubagent !== undefined
      ? { is_subagent: options.isSubagent }
      : {}),
  });
  return {
    agent: projectEphemeralAgent(conversation.id, body, conversation.name),
    conversationId: conversation.id,
  };
}

export async function createLocalEphemeralConversation(
  options: CreateEphemeralConversationOptions,
): Promise<{ agent: AgentState; conversationId: string }> {
  const body = await buildEphemeralConversationCreateBody(options);
  const backend = getBackend();
  const internalAgent = await backend.createAgent({
    agent_type: "letta_v1_agent",
    name: "Ephemeral conversation",
    model: body.model,
    system: body.system,
    memory_blocks: [],
    tags: [],
    tools: [],
    include_base_tools: false,
    include_base_tool_rules: false,
    initial_message_sequence: [],
    parallel_tool_calls: true,
    hidden: true,
  });
  const conversation = await backend.createConversation({
    agent_id: internalAgent.id,
    model: body.model,
    ...(body.model_settings ? { model_settings: body.model_settings } : {}),
    ...(body.context_window_limit
      ? { context_window_limit: body.context_window_limit }
      : {}),
  });

  return {
    agent: internalAgent,
    conversationId: conversation.id,
  };
}
