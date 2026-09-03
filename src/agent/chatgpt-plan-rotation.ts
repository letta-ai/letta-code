/**
 * Turn-local rotation between connected ChatGPT (chatgpt_oauth BYOK)
 * plans when one hits its usage limit. Orgs register multiple ChatGPT plans
 * as separate BYOK providers (e.g. `chatgpt-caren`, `chatgpt-jin`) exposing
 * the same models; when a plan reports `usage_limit_reached` the consumers
 * (TUI / listener / headless) call `rotateChatGPTPlanOnQuotaLimit` from
 * their post-stop retry handling to swap the active conversation onto a
 * sibling plan and resend. No swap-back; quota errors only (no auth failover).
 */

import {
  getAvailableModelHandles,
  getCachedAvailableModels,
} from "@/agent/available-models";
import { resolveModelHandleFromLlmConfig } from "@/agent/model-handles";
import {
  updateAgentLLMConfig,
  updateConversationLLMConfig,
} from "@/agent/modify";
import {
  parseChatGPTUsageLimitDetail,
  selectChatGPTQuotaFailoverHandle,
} from "@/agent/turn-recovery-policy";
import { getBackend } from "@/backend";

/** Maximum plan swaps per turn, enforced by each consumer. */
export const CHATGPT_PLAN_ROTATION_MAX_SWAPS_PER_TURN = 3;

export interface ChatGPTPlanRotationResult {
  fromProvider: string;
  toProvider: string;
  toHandle: string;
  resetsAt: number | null;
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

async function resolveScopedModelHandle(
  agentId: string,
  conversationId: string,
): Promise<string | null> {
  try {
    if (conversationId !== "default") {
      const conversation =
        await getBackend().retrieveConversation(conversationId);
      const conversationRecord = conversation as unknown as {
        model?: unknown;
      };
      if (
        typeof conversationRecord.model === "string" &&
        conversationRecord.model.length > 0
      ) {
        return conversationRecord.model;
      }
    }

    const agent = await getBackend().retrieveAgent(agentId);
    const record = agent as unknown as {
      model?: unknown;
      llm_config?: unknown;
    };
    if (typeof record.model === "string" && record.model.length > 0) {
      return record.model;
    }
    return resolveModelHandleFromLlmConfig(
      record.llm_config as Parameters<
        typeof resolveModelHandleFromLlmConfig
      >[0],
    );
  } catch {
    return null;
  }
}

/**
 * Attempt to rotate the active conversation to the same model on a sibling
 * ChatGPT plan. The default conversation still uses the agent's base model,
 * matching the scope rules used by `/model`.
 * Returns null when the detail is not a usage-limit error, the current
 * handle is not a ChatGPT BYOK handle, no eligible sibling exists, or the
 * model update fails; callers fall through to existing error handling.
 */
export async function rotateChatGPTPlanOnQuotaLimit(params: {
  agentId: string;
  conversationId: string;
  currentHandle: string | null;
  error: unknown;
  exhaustedProviders: Set<string>;
}): Promise<ChatGPTPlanRotationResult | null> {
  const { agentId, conversationId, error, exhaustedProviders } = params;

  const parsedDetail = parseChatGPTUsageLimitDetail(error);
  if (!parsedDetail) return null;

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

  // Prefer persisted scoped state because a caller's render-time model handle
  // can be stale after an automatic swap. Fall back to the caller only when
  // the scoped model cannot be resolved to a ChatGPT BYOK catalog entry.
  let currentHandle = await resolveScopedModelHandle(agentId, conversationId);
  if (!currentHandle || !isChatGPTByokHandleInModels(currentHandle, models)) {
    currentHandle = params.currentHandle;
  }
  if (!currentHandle || !isChatGPTByokHandleInModels(currentHandle, models)) {
    return null;
  }

  const fromProvider = providerFromHandle(currentHandle);
  if (!fromProvider) return null;

  // The current plan is out of quota regardless of whether a sibling exists.
  exhaustedProviders.add(fromProvider);

  const toHandle = selectChatGPTQuotaFailoverHandle({
    currentHandle,
    models,
    exhaustedProviders,
  });
  if (!toHandle) return null;

  const toProvider = providerFromHandle(toHandle);
  if (!toProvider) return null;

  try {
    if (conversationId === "default") {
      await updateAgentLLMConfig(agentId, toHandle, {
        provider_type: "chatgpt_oauth",
      });
    } else {
      await updateConversationLLMConfig(conversationId, toHandle, {
        provider_type: "chatgpt_oauth",
      });
    }
  } catch {
    return null;
  }

  return {
    fromProvider,
    toProvider,
    toHandle,
    resetsAt: parsedDetail.resetsAt,
  };
}

// e.g. `chatgpt-caren hit its usage limit (resets 3:40 PM) — switched to chatgpt-jin`
export function formatPlanRotationNotice(params: {
  fromProvider: string;
  toProvider: string;
  resetsAt: number | null;
}): string {
  const { fromProvider, toProvider, resetsAt } = params;
  const resetSuffix =
    resetsAt !== null
      ? ` (resets ${new Date(resetsAt).toLocaleTimeString([], {
          hour: "numeric",
          minute: "2-digit",
        })})`
      : "";
  return `${fromProvider} hit its usage limit${resetSuffix} — switched to ${toProvider}`;
}
