import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import { getModelContextWindow } from "@/agent/available-models";
import { buildCreateAgentRequest } from "@/agent/create-agent-request";
import { getModelUpdateArgs } from "@/agent/model";
import type { MemoryPromptMode } from "@/agent/prompt-assets";
import { resolveAndBuildSystemPrompt } from "@/agent/system-prompt-resolution";
import { type Backend, getBackend } from "@/backend";
import {
  createEphemeralConversation as createEphemeralConversationRequest,
  type EphemeralConversationCreateBody,
} from "@/backend/api/ephemeral-conversations";

export interface CreateEphemeralConversationOptions {
  model?: string;
  systemPromptPreset?: string;
  systemPromptCustom?: string;
  memoryPromptMode?: MemoryPromptMode;
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
    system: request.system ?? system,
    ...(modelSettings ? { model_settings: modelSettings } : {}),
    ...(contextWindow ? { context_window_limit: contextWindow } : {}),
  };
}

/** Local compatibility state only; the conversation still has no agent. */
export function projectConversationState(conversation: {
  id: string;
  model?: string | null;
  system?: string | null;
  model_settings?: unknown;
  context_window_limit?: number | null;
}): AgentState {
  if (!conversation.model) {
    throw new Error("Cannot resume a conversation without a persisted model.");
  }
  return {
    id: conversation.id,
    name: "Ephemeral conversation",
    system: conversation.system ?? "",
    tools: [],
    memory: { blocks: [] },
    llm_config: {
      handle: conversation.model,
      model: conversation.model,
      context_window: conversation.context_window_limit ?? undefined,
      model_settings: conversation.model_settings ?? {},
    },
    model_settings: conversation.model_settings ?? {},
    message_buffer_autoclear: false,
  } as unknown as AgentState;
}

export async function createEphemeralConversation(
  options: CreateEphemeralConversationOptions,
): Promise<{ agent: AgentState; conversationId: string }> {
  const body = await buildEphemeralConversationCreateBody(options);
  const conversation = await createEphemeralConversationRequest(body);
  return {
    agent: projectConversationState({ ...body, id: conversation.id }),
    conversationId: conversation.id,
  };
}

/** Load compatibility state without replacing a conversation's history owner. */
export async function retrieveResumeState(
  agentId: string | null,
  conversationId: string,
  backend: Pick<
    Backend,
    "retrieveAgent" | "retrieveConversation"
  > = getBackend(),
): Promise<AgentState> {
  return agentId
    ? backend.retrieveAgent(agentId)
    : projectConversationState(
        await backend.retrieveConversation(conversationId),
      );
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
