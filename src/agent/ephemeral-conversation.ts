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
import { LocalBackend } from "@/backend/local/local-backend";

export interface CreateEphemeralConversationOptions {
  model?: string;
  systemPromptPreset?: string;
  systemPromptCustom?: string;
  memoryPromptMode?: MemoryPromptMode;
  name?: string;
  isSubagent?: boolean;
  parentAgentId?: string;
  requestOptions?: { headers?: Record<string, string> };
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
  system?: string | null;
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
      system: conversation.system ?? "",
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
  backendMode: "api" | "local" = "api",
): Promise<{ agent: AgentState; conversationId: string }> {
  const body = await buildEphemeralConversationCreateBody(options);
  const metadata = {
    ...(options.name !== undefined ? { name: options.name } : {}),
    ...(options.isSubagent !== undefined
      ? { is_subagent: options.isSubagent }
      : {}),
  };
  const conversation = await (async () => {
    if (backendMode === "api") {
      return createEphemeralConversationRequest(
        body,
        metadata,
        options.requestOptions,
      );
    }
    const backend = getBackend();
    if (!(backend instanceof LocalBackend)) {
      throw new Error("Detached local conversations require the local backend");
    }
    return backend.createDetachedConversation({ ...body, ...metadata });
  })();
  return {
    agent: projectEphemeralAgent(conversation.id, body, conversation.name),
    conversationId: conversation.id,
  };
}

/** Compatibility entry point for existing local callers; both paths use one body. */
export function createLocalEphemeralConversation(
  options: CreateEphemeralConversationOptions,
): Promise<{ agent: AgentState; conversationId: string }> {
  return createEphemeralConversation(options, "local");
}
