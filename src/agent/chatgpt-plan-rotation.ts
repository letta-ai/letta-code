import {
  getAvailableModelHandles,
  getCachedAvailableModels,
  getModelContextWindow,
} from "@/agent/available-models";
import { resolveModelHandleFromLlmConfig } from "@/agent/model-handles";
import {
  isChatGPTModelUnsupportedError,
  parseChatGPTUsageLimitDetail,
  selectChatGPTQuotaFailoverHandle,
} from "@/agent/turn-recovery-policy";
import { getBackend } from "@/backend";
import type { ChatGPTUsageSnapshot } from "@/providers/chatgpt-usage-service";
import { isRecord } from "@/utils/type-guards";

export const CHATGPT_PLAN_ROTATION_MAX_SWAPS_PER_TURN = 3;

export function isChatGPTPlanExhausted(
  usage: ChatGPTUsageSnapshot,
  now = Date.now(),
): boolean {
  const fetchedAt = Date.parse(usage.fetchedAt);
  if (!Number.isFinite(fetchedAt) || now - fetchedAt > 30_000) return false;
  const hasCredits =
    usage.credits?.unlimited === true || usage.credits?.hasCredits === true;
  if (hasCredits) return false;
  if (usage.limitReached != null) return usage.limitReached;
  return [usage.primary, usage.secondary].some(
    (window) =>
      window?.usedPercent != null &&
      window.usedPercent >= 100 &&
      (window.resetsAt === null || window.resetsAt * 1000 > now),
  );
}

export interface ChatGPTPlanRotationResult {
  fromProvider: string;
  toProvider: string;
  toHandle: string;
  resetsAt: number | null;
  unsupportedModel?: string;
}

function providerFromHandle(handle: string): string | null {
  const idx = handle.indexOf("/");
  return idx > 0 ? handle.slice(0, idx) : null;
}

function isChatGPTByokHandleInModels(
  handle: string,
  models: Array<{
    handle: string;
    providerType?: string;
    providerCategory?: string;
  }>,
): boolean {
  const entry = models.find((m) => m.handle === handle);
  return (
    entry?.providerType === "chatgpt_oauth" &&
    entry?.providerCategory === "byok"
  );
}

interface ScopedModelState {
  handle: string | null;
  modelSettings: Record<string, unknown>;
  contextWindowLimit: number | null;
}

function contextWindowFromEntityRecord(entity: unknown): number | null {
  if (!isRecord(entity)) return null;
  if (typeof entity.context_window_limit === "number") {
    return entity.context_window_limit;
  }
  const llmConfig = entity.llm_config;
  if (isRecord(llmConfig) && typeof llmConfig.context_window === "number") {
    return llmConfig.context_window;
  }
  return null;
}

async function resolveScopedModelState(
  agentId: string,
  conversationId: string,
): Promise<ScopedModelState | null> {
  try {
    const agent = await getBackend().retrieveAgent(agentId);
    const agentRecord = agent as unknown as {
      model?: unknown;
      llm_config?: unknown;
      model_settings?: unknown;
    };
    const agentHandle =
      typeof agentRecord.model === "string" && agentRecord.model.length > 0
        ? agentRecord.model
        : resolveModelHandleFromLlmConfig(
            agentRecord.llm_config as Parameters<
              typeof resolveModelHandleFromLlmConfig
            >[0],
          );
    const llmConfig = isRecord(agentRecord.llm_config)
      ? agentRecord.llm_config
      : {};
    const savedSettings = isRecord(llmConfig.model_settings)
      ? llmConfig.model_settings
      : isRecord(agentRecord.model_settings)
        ? agentRecord.model_settings
        : {};
    const runtimeSettings: Record<string, unknown> = { ...savedSettings };
    for (const key of [
      "temperature",
      "parallel_tool_calls",
      "strict",
      "enable_reasoner",
      "reasoning_effort",
      "max_reasoning_tokens",
      "verbosity",
      "response_format",
      "frequency_penalty",
    ]) {
      if (Object.hasOwn(llmConfig, key)) runtimeSettings[key] = llmConfig[key];
    }
    if (Object.hasOwn(llmConfig, "max_tokens")) {
      runtimeSettings.max_output_tokens = llmConfig.max_tokens;
    }
    const state: ScopedModelState = {
      handle: agentHandle ?? null,
      modelSettings: { ...runtimeSettings, ...savedSettings },
      contextWindowLimit: contextWindowFromEntityRecord(agentRecord),
    };

    if (conversationId !== "default") {
      const conversation = await getBackend().retrieveConversation(
        conversationId,
        {
          query: { include_context_message_ids: false },
        },
      );
      const conversationRecord = conversation as unknown as {
        model?: unknown;
        model_settings?: unknown;
      };
      if (
        typeof conversationRecord.model === "string" &&
        conversationRecord.model.length > 0
      ) {
        state.handle = conversationRecord.model;
        state.modelSettings = runtimeSettings;
        if (state.handle !== agentHandle) {
          state.modelSettings = {};
          state.contextWindowLimit =
            (await getModelContextWindow(state.handle)) ?? null;
        }
        state.modelSettings = {
          ...state.modelSettings,
          ...(isRecord(conversationRecord.model_settings)
            ? conversationRecord.model_settings
            : {}),
        };
      }
      const conversationWindow =
        contextWindowFromEntityRecord(conversationRecord);
      if (typeof conversationWindow === "number") {
        state.contextWindowLimit = conversationWindow;
      }
    }
    return state;
  } catch {
    return null;
  }
}

export async function rotateChatGPTPlanOnQuotaLimit(params: {
  agentId: string;
  conversationId: string;
  currentHandle: string | null;
  error: unknown;
  exhaustedProviders: Set<string>;
  signal?: AbortSignal;
}): Promise<ChatGPTPlanRotationResult | null> {
  const { agentId, conversationId, error, exhaustedProviders, signal } = params;

  const parsedDetail = parseChatGPTUsageLimitDetail(error);
  const modelUnsupported =
    !parsedDetail && isChatGPTModelUnsupportedError(error);
  if (!parsedDetail && !modelUnsupported) return null;

  let models = getCachedAvailableModels();
  if (!models) {
    try {
      await getAvailableModelHandles();
      models = getCachedAvailableModels();
    } catch {
      return null;
    }
  }
  if (!models) return null;

  const scopedState = await resolveScopedModelState(agentId, conversationId);
  if (!scopedState || !scopedState.contextWindowLimit) return null;
  const currentHandle = scopedState.handle;
  if (!currentHandle || !isChatGPTByokHandleInModels(currentHandle, models)) {
    return null;
  }

  const fromProvider = providerFromHandle(currentHandle);
  if (!fromProvider) return null;

  exhaustedProviders.add(fromProvider);

  const excludedProviders = new Set(exhaustedProviders);
  const timeout = AbortSignal.timeout(3_000);
  const usageSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let toHandle: string | null = null;
  while (!signal?.aborted) {
    toHandle = selectChatGPTQuotaFailoverHandle({
      currentHandle,
      models,
      exhaustedProviders: excludedProviders,
    });
    if (!toHandle) return null;
    const provider = providerFromHandle(toHandle);
    if (!provider) return null;
    let usage: ChatGPTUsageSnapshot | null = null;
    try {
      usage =
        (await getBackend().readChatGPTUsage?.(provider, usageSignal)) ?? null;
    } catch {}
    if (signal?.aborted) return null;
    if (
      !usage ||
      usage.providerName !== provider ||
      !isChatGPTPlanExhausted(usage)
    )
      break;
    excludedProviders.add(provider);
  }
  if (signal?.aborted) return null;
  if (!toHandle) return null;

  const toProvider = providerFromHandle(toHandle);
  if (!toProvider) return null;

  const backend = getBackend();
  const payload = {
    model: toHandle,
    model_settings: scopedState.modelSettings,
    context_window_limit: scopedState.contextWindowLimit,
  };

  try {
    signal?.throwIfAborted();
    if (conversationId === "default") {
      await backend.updateAgent(
        agentId,
        payload as Parameters<typeof backend.updateAgent>[1],
        { signal },
      );
    } else {
      await backend.updateConversation(
        conversationId,
        payload as Parameters<typeof backend.updateConversation>[1],
        { signal },
      );
    }
  } catch {
    return null;
  }

  return {
    fromProvider,
    toProvider,
    toHandle,
    resetsAt: parsedDetail?.resetsAt ?? null,
    ...(modelUnsupported
      ? { unsupportedModel: currentHandle.slice(fromProvider.length + 1) }
      : {}),
  };
}

export function formatPlanRotationNotice(params: {
  fromProvider: string;
  toProvider: string;
  resetsAt: number | null;
  unsupportedModel?: string;
}): string {
  const { fromProvider, toProvider, resetsAt, unsupportedModel } = params;
  if (unsupportedModel) {
    return `${fromProvider} doesn't support ${unsupportedModel} — switched to ${toProvider}`;
  }
  const resetSuffix =
    resetsAt !== null
      ? ` (resets ${new Date(resetsAt).toLocaleTimeString([], {
          hour: "numeric",
          minute: "2-digit",
        })})`
      : "";
  return `${fromProvider} hit its usage limit${resetSuffix} — switched to ${toProvider}`;
}
