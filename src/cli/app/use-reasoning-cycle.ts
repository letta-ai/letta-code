// src/cli/app/useReasoningCycle.ts

import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import type { LlmConfig } from "@letta-ai/letta-client/resources/models/models";
import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useCallback,
} from "react";
import {
  CHATGPT_FAST_SERVICE_TIER,
  getChatGptFastRegistryHandleForModelHandle,
  isLocalModelHandle,
  type ModelReasoningEffort,
  normalizeModelHandleForRegistry,
} from "@/agent/model";
import { formatErrorDetails } from "@/cli/helpers/error-formatter";
import { OPENAI_CODEX_PROVIDER_NAME } from "@/providers/openai-codex-provider";

import {
  deriveReasoningEffort,
  mapHandleToLlmConfigPatch,
  providerTypeFromModelSettings,
} from "./model-config";
import type { CommandStarter } from "./types";

type ReasoningCycleDesired = {
  modelHandle: string;
  effort: string;
  modelId: string;
  providerType?: string | null;
  serviceTier?: string | null;
};

function supportsDistinctAnthropicXHighEffort(modelHandle: string): boolean {
  return (
    modelHandle.includes("claude-fable-5") ||
    modelHandle.includes("claude-opus-4-7") ||
    modelHandle.includes("claude-opus-4-8")
  );
}

export function serviceTierForReasoningCycle(
  modelHandle: string,
  modelSettings: AgentState["model_settings"] | null | undefined,
): string | null | undefined {
  if (!getChatGptFastRegistryHandleForModelHandle(modelHandle)) {
    return undefined;
  }
  return (modelSettings as { service_tier?: unknown } | null | undefined)
    ?.service_tier === CHATGPT_FAST_SERVICE_TIER
    ? CHATGPT_FAST_SERVICE_TIER
    : null;
}

type ReasoningCycleContext = {
  agentId: string;
  agentIdRef: MutableRefObject<string>;
  agentStateRef: MutableRefObject<AgentState | null | undefined>;
  commandRunner: CommandStarter;
  conversationOverrideModelSettingsRef: MutableRefObject<
    AgentState["model_settings"] | null
  >;
  conversationIdRef: MutableRefObject<string>;
  currentModelHandleRef: MutableRefObject<string | null>;
  hasConversationModelOverrideRef: MutableRefObject<boolean>;
  isAgentBusy: () => boolean;
  llmConfigRef: MutableRefObject<LlmConfig | null>;
  reasoningCycleDebounceMs: number;
  reasoningCycleDesiredRef: MutableRefObject<ReasoningCycleDesired | null>;
  reasoningCycleInFlightRef: MutableRefObject<boolean>;
  reasoningCycleLastConfirmedAgentStateRef: MutableRefObject<AgentState | null>;
  reasoningCycleLastConfirmedRef: MutableRefObject<LlmConfig | null>;
  reasoningCyclePatchedAgentStateRef: MutableRefObject<boolean>;
  reasoningCycleTimerRef: MutableRefObject<ReturnType<
    typeof setTimeout
  > | null>;
  setAgentState: Dispatch<SetStateAction<AgentState | null | undefined>>;
  setConversationOverrideContextWindowLimit: Dispatch<
    SetStateAction<number | null>
  >;
  setConversationOverrideModelSettings: Dispatch<
    SetStateAction<AgentState["model_settings"] | null>
  >;
  setCurrentModelHandle: Dispatch<SetStateAction<string | null>>;
  setCurrentModelId: Dispatch<SetStateAction<string | null>>;
  setHasConversationModelOverride: (value: boolean) => void;
  setLlmConfig: Dispatch<SetStateAction<LlmConfig | null>>;
  withCommandLock: (fn: () => Promise<void>) => Promise<void>;
};

function isProviderQualifiedModelHandle(
  modelHandle: string | null | undefined,
): modelHandle is string {
  if (!modelHandle) return false;
  const slashIndex = modelHandle.indexOf("/");
  return slashIndex > 0 && slashIndex < modelHandle.length - 1;
}

function modelNameFromHandle(modelHandle: string): string | null {
  const slashIndex = modelHandle.indexOf("/");
  if (slashIndex === -1 || slashIndex === modelHandle.length - 1) return null;
  return modelHandle.slice(slashIndex + 1);
}

function registryProviderForProviderType(providerType: string): string {
  return providerType === "chatgpt_oauth"
    ? OPENAI_CODEX_PROVIDER_NAME
    : providerType;
}

export function resolveReasoningCycleModelHandle(
  llmConfig: LlmConfig | null | undefined,
  agentModel: string | null | undefined,
  currentModelHandle?: string | null,
): string | null {
  if (isProviderQualifiedModelHandle(currentModelHandle)) {
    return currentModelHandle;
  }

  if (isProviderQualifiedModelHandle(agentModel)) {
    return agentModel;
  }

  const model = llmConfig?.model;
  if (!model) return agentModel ?? null;

  if (isLocalModelHandle(model)) {
    return model;
  }

  if (llmConfig?.model_endpoint_type) {
    return `${
      llmConfig.model_endpoint_type === "chatgpt_oauth"
        ? OPENAI_CODEX_PROVIDER_NAME
        : llmConfig.model_endpoint_type
    }/${model}`;
  }

  return model;
}

export function resolveReasoningCycleTierLookupHandle(
  modelHandle: string,
  modelSettings: AgentState["model_settings"] | null | undefined,
): string {
  const normalizedHandle = normalizeModelHandleForRegistry(modelHandle);
  if (normalizedHandle && normalizedHandle !== modelHandle) {
    return normalizedHandle;
  }

  if (isLocalModelHandle(modelHandle)) {
    return modelHandle;
  }

  const providerType = providerTypeFromModelSettings(modelSettings);
  const modelName = modelNameFromHandle(modelHandle);
  if (!providerType || !modelName) {
    return normalizedHandle ?? modelHandle;
  }

  const registryProvider = registryProviderForProviderType(providerType);
  const provider = modelHandle.split("/")[0];
  if (provider === registryProvider) {
    return normalizedHandle ?? modelHandle;
  }

  return `${registryProvider}/${modelName}`;
}

export function useReasoningCycle(ctx: ReasoningCycleContext) {
  const {
    agentId,
    agentIdRef,
    agentStateRef,
    commandRunner,
    conversationOverrideModelSettingsRef,
    conversationIdRef,
    currentModelHandleRef,
    hasConversationModelOverrideRef,
    isAgentBusy,
    llmConfigRef,
    reasoningCycleDebounceMs,
    reasoningCycleDesiredRef,
    reasoningCycleInFlightRef,
    reasoningCycleLastConfirmedAgentStateRef,
    reasoningCycleLastConfirmedRef,
    reasoningCyclePatchedAgentStateRef,
    reasoningCycleTimerRef,
    setAgentState,
    setConversationOverrideContextWindowLimit,
    setConversationOverrideModelSettings,
    setCurrentModelHandle,
    setCurrentModelId,
    setHasConversationModelOverride,
    setLlmConfig,
    withCommandLock,
  } = ctx;

  // Reasoning tier cycling (Tab hotkey in InputRich.tsx)
  //
  // We update the footer immediately (optimistic local state) and debounce the
  // actual server update so users can rapidly cycle tiers.

  // biome-ignore lint/correctness/useExhaustiveDependencies: reasoning refs are stable objects; .current is read dynamically when flushing.
  const flushPendingReasoningEffort = useCallback(async () => {
    const desired = reasoningCycleDesiredRef.current;
    if (!desired) return;

    if (reasoningCycleInFlightRef.current) return;
    if (!agentId) return;

    // Don't change model settings mid-run.
    // If a flush is requested while busy, ensure we still apply once the run completes.
    if (isAgentBusy()) {
      if (reasoningCycleTimerRef.current) {
        clearTimeout(reasoningCycleTimerRef.current);
      }
      reasoningCycleTimerRef.current = setTimeout(() => {
        reasoningCycleTimerRef.current = null;
        void flushPendingReasoningEffort();
      }, reasoningCycleDebounceMs);
      return;
    }

    // Clear any pending timer; we're flushing now.
    if (reasoningCycleTimerRef.current) {
      clearTimeout(reasoningCycleTimerRef.current);
      reasoningCycleTimerRef.current = null;
    }

    reasoningCycleInFlightRef.current = true;
    try {
      await withCommandLock(async () => {
        const cmd = commandRunner.start("/reasoning", "Setting reasoning...");

        try {
          // "default" is a virtual sentinel for the agent's primary history. When
          // active, reasoning tier changes must update the agent itself so the next
          // agent sync doesn't snap back.
          const isDefaultConversation = conversationIdRef.current === "default";
          // Reasoning changes preserve the current context window (keeps 1M
          // dual-listing variants and custom /context-limit values intact) by
          // RE-SENDING it explicitly. Omitting the field would make the
          // server re-derive it from the handle and clamp it to a legacy
          // global default (128k). See LET-9786.
          const preservedContextWindow =
            typeof llmConfigRef.current?.context_window === "number"
              ? { context_window: llmConfigRef.current.context_window }
              : {};
          let conversationModelSettings:
            | AgentState["model_settings"]
            | null
            | undefined;
          let conversationContextWindowLimit: number | null | undefined;
          let updatedAgent: AgentState | null = null;
          if (isDefaultConversation) {
            const { updateAgentLLMConfig } = await import("@/agent/modify");
            updatedAgent = await updateAgentLLMConfig(
              agentIdRef.current,
              desired.modelHandle,
              {
                reasoning_effort: desired.effort,
                ...preservedContextWindow,
                ...(desired.providerType
                  ? { provider_type: desired.providerType }
                  : {}),
                ...(desired.serviceTier !== undefined
                  ? { service_tier: desired.serviceTier }
                  : {}),
              },
            );
          } else {
            const { updateConversationLLMConfig } = await import(
              "@/agent/modify"
            );
            const updatedConversation = await updateConversationLLMConfig(
              conversationIdRef.current,
              desired.modelHandle,
              {
                reasoning_effort: desired.effort,
                ...preservedContextWindow,
                ...(desired.providerType
                  ? { provider_type: desired.providerType }
                  : {}),
                ...(desired.serviceTier !== undefined
                  ? { service_tier: desired.serviceTier }
                  : {}),
              },
            );
            conversationModelSettings = (
              updatedConversation as {
                model_settings?: AgentState["model_settings"] | null;
              }
            ).model_settings;
            conversationContextWindowLimit = (
              updatedConversation as {
                context_window_limit?: number | null;
              }
            ).context_window_limit;
          }
          const resolvedReasoningEffort =
            deriveReasoningEffort(
              isDefaultConversation
                ? (updatedAgent?.model_settings ?? null)
                : conversationModelSettings,
              llmConfigRef.current,
            ) ?? desired.effort;
          const resolvedConversationContextWindowLimit =
            conversationContextWindowLimit === undefined
              ? typeof llmConfigRef.current?.context_window === "number"
                ? llmConfigRef.current.context_window
                : null
              : conversationContextWindowLimit;

          if (isDefaultConversation) {
            setHasConversationModelOverride(false);
            setConversationOverrideModelSettings(null);
            setConversationOverrideContextWindowLimit(null);
            if (updatedAgent) {
              setAgentState(updatedAgent);
            }
          } else {
            setHasConversationModelOverride(true);
            setConversationOverrideModelSettings(
              conversationModelSettings ?? null,
            );
            setConversationOverrideContextWindowLimit(
              resolvedConversationContextWindowLimit,
            );
          }

          // The API may not echo reasoning_effort back; preserve explicit desired effort.
          setLlmConfig({
            ...(updatedAgent?.llm_config ??
              llmConfigRef.current ??
              ({} as LlmConfig)),
            ...mapHandleToLlmConfigPatch(
              desired.modelHandle,
              providerTypeFromModelSettings(
                isDefaultConversation
                  ? (updatedAgent?.model_settings ?? null)
                  : conversationModelSettings,
              ),
            ),
            reasoning_effort: resolvedReasoningEffort as ModelReasoningEffort,
            ...(typeof resolvedConversationContextWindowLimit === "number"
              ? { context_window: resolvedConversationContextWindowLimit }
              : {}),
          } as LlmConfig);
          setCurrentModelId(desired.modelId);
          setCurrentModelHandle(desired.modelHandle);

          // Clear pending state.
          reasoningCycleDesiredRef.current = null;
          reasoningCycleLastConfirmedRef.current = null;
          reasoningCycleLastConfirmedAgentStateRef.current = null;
          reasoningCyclePatchedAgentStateRef.current = false;

          const display =
            desired.effort === "medium"
              ? "med"
              : desired.effort === "minimal"
                ? "low"
                : desired.effort;
          cmd.finish(`Reasoning set to ${display}`, true);
        } catch (error) {
          const errorDetails = formatErrorDetails(error, agentId);
          cmd.fail(`Failed to set reasoning: ${errorDetails}`);

          // Revert optimistic UI if we have a confirmed config snapshot.
          if (reasoningCycleLastConfirmedRef.current) {
            const prev = reasoningCycleLastConfirmedRef.current;
            reasoningCycleDesiredRef.current = null;
            reasoningCycleLastConfirmedRef.current = null;
            setLlmConfig(prev);
            // Also revert the agentState optimistic patch
            if (
              reasoningCyclePatchedAgentStateRef.current &&
              reasoningCycleLastConfirmedAgentStateRef.current
            ) {
              setAgentState(reasoningCycleLastConfirmedAgentStateRef.current);
              reasoningCycleLastConfirmedAgentStateRef.current = null;
            }
            reasoningCyclePatchedAgentStateRef.current = false;

            const { getModelInfo } = await import("@/agent/model");
            const modelHandle =
              prev.model_endpoint_type && prev.model
                ? `${
                    prev.model_endpoint_type === "chatgpt_oauth"
                      ? OPENAI_CODEX_PROVIDER_NAME
                      : prev.model_endpoint_type
                  }/${prev.model}`
                : prev.model;
            const modelInfo = modelHandle ? getModelInfo(modelHandle) : null;
            setCurrentModelId(modelInfo?.id ?? null);
          }
        }
      });
    } finally {
      reasoningCycleInFlightRef.current = false;
    }
  }, [
    agentId,
    commandRunner,
    isAgentBusy,
    withCommandLock,
    setHasConversationModelOverride,
    reasoningCycleDebounceMs,
    reasoningCycleDesiredRef,
    reasoningCycleInFlightRef,
    reasoningCycleLastConfirmedAgentStateRef,
    reasoningCycleLastConfirmedRef,
    reasoningCyclePatchedAgentStateRef,
    reasoningCycleTimerRef,
    setAgentState,
    setConversationOverrideContextWindowLimit,
    setConversationOverrideModelSettings,
    setCurrentModelHandle,
    setCurrentModelId,
    setLlmConfig,
  ]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refs are stable objects, .current is read dynamically
  const handleCycleReasoningEffort = useCallback(() => {
    void (async () => {
      if (!agentId) return;
      if (reasoningCycleInFlightRef.current) return;

      const current = llmConfigRef.current;
      const modelSettingsForEffort = hasConversationModelOverrideRef.current
        ? conversationOverrideModelSettingsRef.current
        : agentStateRef.current?.model_settings;
      const providerType = providerTypeFromModelSettings(
        modelSettingsForEffort,
      );
      const modelHandle = resolveReasoningCycleModelHandle(
        current,
        hasConversationModelOverrideRef.current
          ? null
          : (agentStateRef.current?.model ?? null),
        currentModelHandleRef.current,
      );
      if (!modelHandle) return;

      // Derive current effort from effective model settings (conversation override aware)
      const currentEffort =
        deriveReasoningEffort(modelSettingsForEffort, current) ?? "none";
      const tierLookupHandle = resolveReasoningCycleTierLookupHandle(
        modelHandle,
        modelSettingsForEffort,
      );

      const { getReasoningTierOptionsForHandle } = await import(
        "@/agent/model"
      );
      const tiers = getReasoningTierOptionsForHandle(tierLookupHandle).map(
        (option) => ({
          id: option.modelId,
          effort: option.effort,
        }),
      );

      // Only enable cycling when there are multiple tiers for the same handle.
      if (tiers.length < 2) return;

      const anthropicXHighEffort = supportsDistinctAnthropicXHighEffort(
        tierLookupHandle,
      )
        ? "xhigh"
        : "max";

      const order = [
        "none",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ];
      const rank = (effort: string): number => {
        const idx = order.indexOf(effort);
        return idx >= 0 ? idx : 999;
      };

      const sorted = [...tiers].sort((a, b) => rank(a.effort) - rank(b.effort));
      const curIndex = sorted.findIndex((t) => t.effort === currentEffort);
      const nextIndex = (curIndex + 1) % sorted.length;
      const next = sorted[nextIndex];
      if (!next) return;
      const serviceTier = serviceTierForReasoningCycle(
        tierLookupHandle,
        modelSettingsForEffort,
      );

      // Snapshot the last confirmed config once per burst so we can revert on failure.
      if (!reasoningCycleLastConfirmedRef.current) {
        reasoningCycleLastConfirmedRef.current = current ?? null;
        reasoningCycleLastConfirmedAgentStateRef.current =
          hasConversationModelOverrideRef.current
            ? null
            : (agentStateRef.current ?? null);
      }

      // Optimistic UI update (footer changes immediately).
      setLlmConfig((prev: LlmConfig | null) =>
        prev ? ({ ...prev, reasoning_effort: next.effort } as LlmConfig) : prev,
      );
      // Patch agentState.model_settings only when operating on agent defaults.
      if (!hasConversationModelOverrideRef.current) {
        reasoningCyclePatchedAgentStateRef.current = true;
        setAgentState((prev: AgentState | null | undefined) => {
          if (!prev) return prev ?? null;
          const ms = prev.model_settings;
          if (!ms || !("provider_type" in ms)) return prev;
          if (
            ms.provider_type === "openai" ||
            ms.provider_type === "chatgpt_oauth"
          ) {
            return {
              ...prev,
              model_settings: {
                ...ms,
                reasoning: {
                  ...(ms as { reasoning?: Record<string, unknown> }).reasoning,
                  reasoning_effort: next.effort as
                    | "none"
                    | "minimal"
                    | "low"
                    | "medium"
                    | "high"
                    | "xhigh"
                    | "max",
                },
              },
            } as AgentState;
          }
          if (
            ms.provider_type === "anthropic" ||
            ms.provider_type === "bedrock"
          ) {
            // "xhigh" is distinct on Fable and Opus 4.7+; older Anthropic models map it to backend "max".
            return {
              ...prev,
              model_settings: {
                ...ms,
                effort: (next.effort === "xhigh"
                  ? anthropicXHighEffort
                  : next.effort) as "low" | "medium" | "high" | "xhigh" | "max",
              },
            } as AgentState;
          }
          return prev;
        });
      } else {
        reasoningCyclePatchedAgentStateRef.current = false;
      }
      setCurrentModelId(next.id);

      // Debounce the server update.
      reasoningCycleDesiredRef.current = {
        modelHandle,
        effort: next.effort,
        modelId: next.id,
        providerType,
        serviceTier,
      };
      if (reasoningCycleTimerRef.current) {
        clearTimeout(reasoningCycleTimerRef.current);
      }
      reasoningCycleTimerRef.current = setTimeout(() => {
        reasoningCycleTimerRef.current = null;
        void flushPendingReasoningEffort();
      }, reasoningCycleDebounceMs);
    })();
  }, [agentId, flushPendingReasoningEffort]);

  return {
    flushPendingReasoningEffort,
    handleCycleReasoningEffort,
  };
}
