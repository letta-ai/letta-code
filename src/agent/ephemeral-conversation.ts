import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import { getModelContextWindow } from "@/agent/available-models";
import { buildCreateAgentRequest } from "@/agent/create-agent-request";
import { getModelUpdateArgs } from "@/agent/model";
import type { MemoryPromptMode } from "@/agent/prompt-assets";
import { resolveAndBuildSystemPrompt } from "@/agent/system-prompt-resolution";
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
    system: request.system,
    ...(modelSettings ? { model_settings: modelSettings } : {}),
    ...(contextWindow ? { context_window_limit: contextWindow } : {}),
  };
}

export async function createEphemeralConversation(
  options: CreateEphemeralConversationOptions,
): Promise<{ agent: AgentState; conversationId: string }> {
  const body = await buildEphemeralConversationCreateBody(options);
  const conversation = await createEphemeralConversationRequest(body);
  const agent = {
    id: conversation.id,
    name: "Ephemeral conversation",
    system: body.system,
    tools: [],
    tags: [],
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

  return { agent, conversationId: conversation.id };
}
