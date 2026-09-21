import {
  CHATGPT_PLAN_ROTATION_MAX_SWAPS_PER_TURN,
  formatPlanRotationNotice,
  isChatGPTOAuthCredentialFailure,
  rotateChatGPTPlanOnRecoverableFailure,
} from "@/agent/chatgpt-plan-rotation";
import {
  isQuotaLimitErrorDetail,
  parseChatGPTUsageLimitDetail,
  TEMP_QUOTA_OVERRIDE_MODEL,
} from "@/agent/turn-recovery-policy";
import { getBackend } from "@/backend";
import { settingsManager } from "@/settings-manager";

export interface RecoveryDependencies {
  rotatePlan: typeof rotateChatGPTPlanOnRecoverableFailure;
  supportsHostedAuto: () => boolean;
  autoSwapEnabled: () => boolean;
}

const DEFAULT_DEPENDENCIES: RecoveryDependencies = {
  rotatePlan: rotateChatGPTPlanOnRecoverableFailure,
  supportsHostedAuto: () => !getBackend().capabilities.localModelCatalog,
  autoSwapEnabled: () =>
    settingsManager.getSetting("autoSwapOnQuotaLimit") !== false,
};

export type ListenerModelRecoveryAction =
  | {
      kind: "plan_rotation";
      message: string;
      chatgptPlanSwaps: number;
      overrideModel: string;
      attempt: number;
      maxAttempts: number;
    }
  | {
      kind: "auto_fallback";
      message: string;
      overrideModel: typeof TEMP_QUOTA_OVERRIDE_MODEL;
      attempt: 1;
      maxAttempts: 1;
    };

/**
 * Choose model recovery without sending the retry. Authentication failover is
 * deliberately allowed only after this turn already auto-rotated for quota;
 * an explicitly selected account with stale credentials must still ask the
 * user to reconnect instead of silently changing providers.
 */
export async function recoverListenerModelFailure(params: {
  agentId: string;
  conversationId: string;
  error: unknown;
  errorDetail: string | null;
  exhaustedProviders: Set<string>;
  chatgptPlanSwaps: number;
  autoFallbackAttempted: boolean;
  activeOverrideModel?: string;
  signal?: AbortSignal;
  dependencies?: RecoveryDependencies;
}): Promise<ListenerModelRecoveryAction | null> {
  const dependencies = params.dependencies ?? DEFAULT_DEPENDENCIES;
  if (params.activeOverrideModel === TEMP_QUOTA_OVERRIDE_MODEL) return null;
  const isQuotaFailure =
    parseChatGPTUsageLimitDetail(params.error) !== null ||
    isQuotaLimitErrorDetail(params.errorDetail);
  const isAuthenticationFailure = isChatGPTOAuthCredentialFailure(params.error);
  const canRecoverAuthentication =
    isAuthenticationFailure && params.chatgptPlanSwaps > 0;
  if (!isQuotaFailure && !canRecoverAuthentication) return null;

  if (params.chatgptPlanSwaps < CHATGPT_PLAN_ROTATION_MAX_SWAPS_PER_TURN) {
    const rotation = await dependencies.rotatePlan({
      agentId: params.agentId,
      conversationId: params.conversationId,
      currentHandle: null,
      error: params.error,
      exhaustedProviders: params.exhaustedProviders,
      signal: params.signal,
    });
    if (rotation) {
      return {
        kind: "plan_rotation",
        message: formatPlanRotationNotice(rotation),
        chatgptPlanSwaps: params.chatgptPlanSwaps + 1,
        overrideModel: rotation.toHandle,
        attempt: params.chatgptPlanSwaps + 1,
        maxAttempts: CHATGPT_PLAN_ROTATION_MAX_SWAPS_PER_TURN,
      };
    }
  }

  if (
    params.autoFallbackAttempted ||
    !dependencies.autoSwapEnabled() ||
    !dependencies.supportsHostedAuto()
  ) {
    return null;
  }

  return {
    kind: "auto_fallback",
    message: isAuthenticationFailure
      ? "The automatically selected ChatGPT account needs to reconnect; temporarily switching to Auto and continuing..."
      : "Quota limit reached; temporarily switching to Auto and continuing...",
    overrideModel: TEMP_QUOTA_OVERRIDE_MODEL,
    attempt: 1,
    maxAttempts: 1,
  };
}
