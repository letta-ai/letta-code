// src/cli/app/useConfigurationHandlers.ts

import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import type { LlmConfig } from "@letta-ai/letta-client/resources/models/models";
import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useCallback,
} from "react";
import {
  type ModelReasoningEffort,
  shouldPreserveContextWindowForModelSelection,
} from "@/agent/model";
import { applyPersonalityToMemory } from "@/agent/personality";
import {
  getPersonalityBlockValues,
  getPersonalityOption,
  type PersonalityId,
} from "@/agent/personality-presets";
import { getBackend } from "@/backend";
import { getClient } from "@/backend/api/client";
import type { ModelSelectorSelection } from "@/cli/components/ModelSelector";
import {
  type ContextTracker,
  resetContextHistory,
} from "@/cli/helpers/context-tracker";
import { formatErrorDetails } from "@/cli/helpers/error-formatter";
import {
  persistReflectionSettingsForAgent,
  type ReflectionSettings,
} from "@/cli/helpers/memory-reminder";
import { DEFAULT_SUMMARIZATION_MODEL } from "@/constants";
import { experimentManager } from "@/experiments/manager";
import type { ExperimentId } from "@/experiments/types";
import { OPENAI_CODEX_PROVIDER_NAME } from "@/providers/openai-codex-provider";
import { settingsManager } from "@/settings-manager";
import { getToolNames } from "@/tools/manager";
import type { ToolsetName, ToolsetPreference } from "@/tools/toolset";
import { formatToolsetName } from "@/tools/toolset-labels";

import {
  deriveReasoningEffort,
  mapHandleToLlmConfigPatch,
  providerTypeFromModelSettings,
  providerTypeFromUpdateArgs,
} from "./model-config";
import { formatReflectionSettings } from "./reflection";
import type {
  ActiveOverlay,
  AppCommandRunner,
  OverlayCommandConsumer,
  QueuedOverlayAction,
} from "./types";

type ModelReasoningPrompt = {
  modelLabel: string;
  initialModelId: string;
  initialEffort?: ModelReasoningEffort;
  options: Array<{
    effort: ModelReasoningEffort;
    modelId: string;
    selection?: ModelSelectorSelection;
  }>;
};

type ToolsetChangeReminderParams = {
  source: string;
  previousToolset: string | null;
  newToolset: string | null;
  previousTools: string[];
  newTools: string[];
};

type ConfigurationHandlersContext = {
  activeOverlay: ActiveOverlay;
  agentId: string;
  agentIdRef: MutableRefObject<string>;
  agentState: AgentState | null | undefined;
  commandRunner: AppCommandRunner;
  consumeOverlayCommand: OverlayCommandConsumer;
  contextTrackerRef: MutableRefObject<ContextTracker>;
  conversationIdRef: MutableRefObject<string>;
  currentModelHandle: string | null;
  currentModelId: string | null;
  currentToolset: ToolsetName | null;
  isAgentBusy: () => boolean;
  llmConfig: LlmConfig | null;
  llmConfigRef: MutableRefObject<LlmConfig | null>;
  maybeRecordToolsetChangeReminder: (
    params: ToolsetChangeReminderParams,
  ) => void;
  resetPendingReasoningCycle: () => void;
  setActiveOverlay: Dispatch<SetStateAction<ActiveOverlay>>;
  setAgentState: Dispatch<SetStateAction<AgentState | null | undefined>>;
  setConversationOverrideContextWindowLimit: Dispatch<
    SetStateAction<number | null>
  >;
  setConversationOverrideModelSettings: Dispatch<
    SetStateAction<AgentState["model_settings"] | null>
  >;
  setCurrentModelHandle: Dispatch<SetStateAction<string | null>>;
  setCurrentModelId: Dispatch<SetStateAction<string | null>>;
  setHasAvailableLocalModels: Dispatch<SetStateAction<boolean>>;
  setCurrentPersonalityId: Dispatch<SetStateAction<PersonalityId | null>>;
  setCurrentSystemPromptId: Dispatch<SetStateAction<string | null>>;
  setCurrentToolset: Dispatch<SetStateAction<ToolsetName | null>>;
  setCurrentToolsetPreference: Dispatch<SetStateAction<ToolsetPreference>>;
  setHasConversationModelOverride: (value: boolean) => void;
  setLlmConfig: Dispatch<SetStateAction<LlmConfig | null>>;
  setModelReasoningPrompt: Dispatch<
    SetStateAction<ModelReasoningPrompt | null>
  >;
  setQueuedOverlayAction: Dispatch<SetStateAction<QueuedOverlayAction>>;
  setTempModelOverride: (next: string | null) => void;
  withCommandLock: (asyncFn: () => Promise<void>) => Promise<void>;
};

export function useConfigurationHandlers(ctx: ConfigurationHandlersContext) {
  const {
    activeOverlay,
    agentId,
    agentIdRef,
    agentState,
    commandRunner,
    consumeOverlayCommand,
    contextTrackerRef,
    conversationIdRef,
    currentModelHandle,
    currentModelId,
    currentToolset,
    isAgentBusy,
    llmConfig,
    llmConfigRef,
    maybeRecordToolsetChangeReminder,
    resetPendingReasoningCycle,
    setActiveOverlay,
    setAgentState,
    setConversationOverrideContextWindowLimit,
    setConversationOverrideModelSettings,
    setCurrentModelHandle,
    setCurrentModelId,
    setHasAvailableLocalModels,
    setCurrentPersonalityId,
    setCurrentSystemPromptId,
    setCurrentToolset,
    setCurrentToolsetPreference,
    setHasConversationModelOverride,
    setLlmConfig,
    setModelReasoningPrompt,
    setQueuedOverlayAction,
    setTempModelOverride,
    withCommandLock,
  } = ctx;

  // biome-ignore lint/correctness/useExhaustiveDependencies: model switch refs are stable objects; .current is read dynamically during selection.
  const handleModelSelect = useCallback(
    async (
      model: string | ModelSelectorSelection,
      commandId?: string | null,
      opts?: {
        promptReasoning?: boolean;
        skipReasoningPrompt?: boolean;
        reasoningEffort?: ModelReasoningEffort;
      },
    ) => {
      const inputSelection = typeof model === "string" ? null : model;
      const modelId = typeof model === "string" ? model : model.id;
      let overlayCommand = commandId
        ? commandRunner.getHandle(commandId, "/model")
        : null;
      const resolveOverlayCommand = () => {
        if (overlayCommand) {
          return overlayCommand;
        }
        overlayCommand = consumeOverlayCommand("model");
        return overlayCommand;
      };

      let selectedModel: {
        id: string;
        handle?: string;
        label: string;
        updateArgs?: Record<string, unknown>;
        description?: string;
        registryHandle?: string;
      } | null = null;

      try {
        const {
          getChatGptFastRegistryHandleForModelHandle,
          getReasoningTierOptionsForHandle,
          normalizeModelHandleForRegistry,
          models,
        } = await import("@/agent/model");
        const pickPreferredModelForHandle = (handle: string) => {
          const registryHandle =
            normalizeModelHandleForRegistry(handle) ?? handle;
          const candidates = models.filter((m) => m.handle === registryHandle);
          return (
            candidates.find((m) => m.isDefault) ??
            candidates.find((m) => m.isFeatured) ??
            candidates.find(
              (m) =>
                (m.updateArgs as { reasoning_effort?: unknown } | undefined)
                  ?.reasoning_effort === "medium",
            ) ??
            candidates.find(
              (m) =>
                (m.updateArgs as { reasoning_effort?: unknown } | undefined)
                  ?.reasoning_effort === "high",
            ) ??
            candidates[0] ??
            null
          );
        };
        let apiProviderType: string | undefined;
        let didLoadApiProviderType = false;
        const getApiProviderType = async () => {
          if (didLoadApiProviderType) return apiProviderType;
          const { getModelProviderType } = await import(
            "@/agent/available-models"
          );
          apiProviderType = await getModelProviderType(modelId);
          didLoadApiProviderType = true;
          return apiProviderType;
        };
        const registryHandleForProviderType = (
          handle: string,
          providerType?: string,
        ) => {
          if (providerType !== "chatgpt_oauth") return handle;
          const slashIndex = handle.indexOf("/");
          if (slashIndex === -1) return handle;
          return `${OPENAI_CODEX_PROVIDER_NAME}/${handle.slice(slashIndex + 1)}`;
        };
        selectedModel = inputSelection
          ? {
              id: inputSelection.id,
              handle: inputSelection.handle,
              label: inputSelection.label,
              description: inputSelection.description,
              updateArgs: inputSelection.updateArgs,
              registryHandle: inputSelection.registryHandle,
            }
          : (models.find((m) => m.id === modelId) ?? null);

        if (!selectedModel && modelId.includes("/")) {
          const providerType = await getApiProviderType();
          const registryCandidate = registryHandleForProviderType(
            modelId,
            providerType,
          );
          const handleMatch = pickPreferredModelForHandle(registryCandidate);
          if (handleMatch) {
            const fastRegistryHandle =
              getChatGptFastRegistryHandleForModelHandle(registryCandidate);
            const updateArgs = {
              ...((handleMatch.updateArgs as
                | Record<string, unknown>
                | undefined) ?? {}),
              ...(fastRegistryHandle ? { service_tier: null } : {}),
              ...(providerType ? { provider_type: providerType } : {}),
            };
            selectedModel = {
              ...handleMatch,
              id: modelId,
              handle: modelId,
              registryHandle:
                normalizeModelHandleForRegistry(registryCandidate) ??
                registryCandidate,
              updateArgs:
                Object.keys(updateArgs).length > 0 ? updateArgs : undefined,
            } as unknown as (typeof models)[number];
          }
        }

        if (!selectedModel && modelId.includes("/")) {
          const { getModelContextWindow } = await import(
            "@/agent/available-models"
          );
          const providerType = await getApiProviderType();
          const apiContextWindow = await getModelContextWindow(modelId);
          const updateArgs: Record<string, unknown> = {
            ...(apiContextWindow ? { context_window: apiContextWindow } : {}),
            ...(providerType ? { provider_type: providerType } : {}),
            ...(opts?.reasoningEffort
              ? { reasoning_effort: opts.reasoningEffort }
              : {}),
          };

          selectedModel = {
            id: modelId,
            handle: modelId,
            label: modelId.split("/").pop() ?? modelId,
            description: "Custom model",
            updateArgs:
              Object.keys(updateArgs).length > 0 ? updateArgs : undefined,
          } as unknown as (typeof models)[number];
        }

        if (selectedModel && opts?.reasoningEffort) {
          selectedModel = {
            ...selectedModel,
            updateArgs: {
              ...(selectedModel.updateArgs ?? {}),
              reasoning_effort: opts.reasoningEffort,
            },
          };
        }

        if (!selectedModel) {
          const output = `Model not found: ${modelId}. Run /model and press R to refresh available models.`;
          const cmd =
            resolveOverlayCommand() ?? commandRunner.start("/model", output);
          cmd.fail(output);
          return;
        }
        const model = selectedModel;
        const modelHandle = model.handle ?? model.id;
        const registryHandle =
          model.registryHandle ??
          normalizeModelHandleForRegistry(modelHandle) ??
          modelHandle;
        const modelUpdateArgs = model.updateArgs as
          | {
              reasoning_effort?: unknown;
              enable_reasoner?: unknown;
              service_tier?: unknown;
            }
          | undefined;
        const rawReasoningEffort = modelUpdateArgs?.reasoning_effort;
        const usesDistinctXHighLabel = /Fable 5|Opus 4\.[78]|GPT-5\.6/.test(
          model.label,
        );
        const reasoningLevel =
          typeof rawReasoningEffort === "string"
            ? rawReasoningEffort === "none"
              ? "no"
              : rawReasoningEffort === "xhigh"
                ? usesDistinctXHighLabel
                  ? "extra-high"
                  : "max"
                : rawReasoningEffort
            : modelUpdateArgs?.enable_reasoner === false
              ? "no"
              : null;
        const selectedContextWindow = (
          model.updateArgs as { context_window?: number } | undefined
        )?.context_window;
        const reasoningTierOptions = getReasoningTierOptionsForHandle(
          registryHandle,
          selectedContextWindow,
        ).map((option) => {
          const optionModel = models.find(
            (entry) => entry.id === option.modelId,
          );
          const serviceTier = modelUpdateArgs?.service_tier;
          const providerType = providerTypeFromUpdateArgs(modelUpdateArgs);
          const optionUpdateArgs = {
            ...((optionModel?.updateArgs as
              | Record<string, unknown>
              | undefined) ?? {}),
            ...(serviceTier !== undefined ? { service_tier: serviceTier } : {}),
            ...(providerType ? { provider_type: providerType } : {}),
          };
          return {
            ...option,
            selection: {
              id: option.modelId,
              handle: modelHandle,
              label: model.label,
              description: model.description ?? "",
              registryHandle,
              updateArgs: optionUpdateArgs,
            },
          };
        });

        if (
          !opts?.skipReasoningPrompt &&
          (opts?.promptReasoning || activeOverlay === "model") &&
          reasoningTierOptions.length > 1
        ) {
          const selectedEffort = (
            model.updateArgs as { reasoning_effort?: unknown } | undefined
          )?.reasoning_effort;
          const preferredOption =
            (typeof selectedEffort === "string" &&
              reasoningTierOptions.find(
                (option) => option.effort === selectedEffort,
              )) ??
            reasoningTierOptions.find((option) => option.effort === "medium") ??
            reasoningTierOptions[0];

          if (preferredOption) {
            setModelReasoningPrompt({
              modelLabel: model.label,
              initialModelId: preferredOption.modelId,
              initialEffort: preferredOption.effort,
              options: reasoningTierOptions,
            });
            return;
          }
        }

        // Switching models should discard any pending debounce from the previous model.
        resetPendingReasoningCycle();

        if (isAgentBusy()) {
          setActiveOverlay(null);
          const cmd =
            resolveOverlayCommand() ??
            commandRunner.start(
              "/model",
              `Model switch queued – will switch after current task completes`,
            );
          cmd.update({
            output: `Model switch queued – will switch after current task completes`,
            phase: "running",
          });
          setQueuedOverlayAction({
            type: "switch_model",
            modelId,
            modelSelection: inputSelection ?? undefined,
            commandId: cmd.id,
          });
          return;
        }

        const currentLlmConfig = llmConfigRef.current;
        const shouldPreserveContextWindow =
          shouldPreserveContextWindowForModelSelection({
            currentModelHandle,
            currentModelId,
            currentLlmConfig,
            selectedModelHandle: modelHandle,
            selectedContextWindow,
          });
        const modelUpdateArgsForRequest = model.updateArgs
          ? { ...(model.updateArgs as Record<string, unknown>) }
          : undefined;
        if (shouldPreserveContextWindow && modelUpdateArgsForRequest) {
          delete modelUpdateArgsForRequest.context_window;
        }

        await withCommandLock(async () => {
          const cmd =
            resolveOverlayCommand() ??
            commandRunner.start(
              "/model",
              `Switching model to ${model.label}...`,
            );
          cmd.update({
            output: `Switching model to ${model.label}...`,
            phase: "running",
          });

          // "default" is a virtual sentinel for the agent's primary history, not a
          // real conversation object. When active, model changes must update the agent
          // itself (otherwise the next agent sync will snap back).
          const isDefaultConversation = conversationIdRef.current === "default";
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
              modelHandle,
              modelUpdateArgsForRequest,
              {
                avoidOverwritingExistingContextWindow:
                  shouldPreserveContextWindow,
              },
            );
            conversationModelSettings = updatedAgent?.model_settings;
          } else {
            const { updateConversationLLMConfig } = await import(
              "@/agent/modify"
            );
            const updatedConversation = await updateConversationLLMConfig(
              conversationIdRef.current,
              modelHandle,
              modelUpdateArgsForRequest,
              {
                avoidOverwritingExistingContextWindow:
                  shouldPreserveContextWindow,
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

          // The API may not echo reasoning_effort back, so populate it from
          // model.updateArgs as a reliable fallback.
          const rawEffort = modelUpdateArgs?.reasoning_effort;
          const resolvedReasoningEffort =
            typeof rawEffort === "string"
              ? rawEffort
              : (deriveReasoningEffort(
                  conversationModelSettings,
                  llmConfigRef.current,
                ) ?? null);

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
          }

          const presetContextWindow = modelUpdateArgsForRequest?.context_window;
          const preservedContextWindow = llmConfigRef.current?.context_window;
          const resolvedContextWindow =
            typeof conversationContextWindowLimit === "number"
              ? conversationContextWindowLimit
              : shouldPreserveContextWindow &&
                  typeof preservedContextWindow === "number"
                ? preservedContextWindow
                : typeof presetContextWindow === "number"
                  ? presetContextWindow
                  : undefined;
          const resolvedProviderType =
            providerTypeFromModelSettings(conversationModelSettings) ??
            providerTypeFromUpdateArgs(modelUpdateArgsForRequest) ??
            providerTypeFromUpdateArgs(modelUpdateArgs);
          if (!isDefaultConversation) {
            setConversationOverrideContextWindowLimit(
              typeof resolvedContextWindow === "number"
                ? resolvedContextWindow
                : null,
            );
          }

          setLlmConfig({
            ...(updatedAgent?.llm_config ??
              llmConfigRef.current ??
              ({} as LlmConfig)),
            ...mapHandleToLlmConfigPatch(modelHandle, resolvedProviderType),
            ...(typeof resolvedReasoningEffort === "string"
              ? {
                  reasoning_effort:
                    resolvedReasoningEffort as ModelReasoningEffort,
                }
              : {}),
            ...(typeof resolvedContextWindow === "number"
              ? { context_window: resolvedContextWindow }
              : {}),
          } as LlmConfig);
          setCurrentModelId(modelId);
          setTempModelOverride(null);

          // Record the previous and new model in recents (by handle, since
          // availableHandles in ModelSelector uses handles).
          // The "from" model is added first so the "to" model ends up at the
          // front of the list after both addRecentModel calls.
          if (currentModelHandle) {
            settingsManager.addRecentModel(currentModelHandle);
          }
          settingsManager.addRecentModel(modelHandle);

          // Reset context token tracking since different models have different tokenizers
          resetContextHistory(contextTrackerRef.current);
          setCurrentModelHandle(modelHandle);
          setHasAvailableLocalModels(true);

          const persistedToolsetPreference =
            settingsManager.getToolsetPreference(agentId);
          const previousToolsetSnapshot = currentToolset;
          const previousToolNamesSnapshot = getToolNames();
          let toolsetNoticeLine: string | null = null;

          if (persistedToolsetPreference === "auto") {
            const { switchToolsetForModel } = await import("@/tools/toolset");
            const toolsetName = await switchToolsetForModel(
              modelHandle,
              agentId,
              resolvedProviderType,
            );
            setCurrentToolsetPreference("auto");
            setCurrentToolset(toolsetName);
            // Only notify when the toolset actually changes (e.g., Claude → Codex)
            if (toolsetName !== currentToolset) {
              toolsetNoticeLine =
                "Auto toolset selected: switched to " +
                formatToolsetName(toolsetName) +
                ". Use /toolset to set a manual override.";
              maybeRecordToolsetChangeReminder({
                source: "/model (auto toolset)",
                previousToolset: previousToolsetSnapshot,
                newToolset: toolsetName,
                previousTools: previousToolNamesSnapshot,
                newTools: getToolNames(),
              });
            }
          } else {
            const { forceToolsetSwitch } = await import("@/tools/toolset");
            if (currentToolset !== persistedToolsetPreference) {
              await forceToolsetSwitch(persistedToolsetPreference, agentId);
              setCurrentToolset(persistedToolsetPreference);
              maybeRecordToolsetChangeReminder({
                source: "/model (manual toolset override)",
                previousToolset: previousToolsetSnapshot,
                newToolset: persistedToolsetPreference,
                previousTools: previousToolNamesSnapshot,
                newTools: getToolNames(),
              });
            }
            setCurrentToolsetPreference(persistedToolsetPreference);
            toolsetNoticeLine =
              "Manual toolset override remains active: " +
              formatToolsetName(persistedToolsetPreference) +
              ".";
          }

          const outputLines = [
            "Switched to " +
              model.label +
              (reasoningLevel ? ` (${reasoningLevel} reasoning)` : ""),
            ...(toolsetNoticeLine ? [toolsetNoticeLine] : []),
          ].join("\n");

          cmd.finish(outputLines, true);
        });
      } catch (error) {
        const errorDetails = formatErrorDetails(error, agentId);
        const modelLabel = selectedModel?.label ?? modelId;
        const guidance =
          "Run /model and press R to refresh available models. If the model is still unavailable, choose another model or connect a provider with /connect.";
        const cmd =
          resolveOverlayCommand() ??
          commandRunner.start(
            "/model",
            `Failed to switch model to ${modelLabel}.`,
          );
        cmd.fail(
          `Failed to switch model to ${modelLabel}: ${errorDetails}\n${guidance}`,
        );
      }
    },
    [
      activeOverlay,
      agentId,
      commandRunner,
      consumeOverlayCommand,
      currentModelHandle,
      currentModelId,
      currentToolset,
      isAgentBusy,
      maybeRecordToolsetChangeReminder,
      resetPendingReasoningCycle,
      withCommandLock,
      setHasConversationModelOverride,
      setTempModelOverride,
      setActiveOverlay,
      setAgentState,
      setConversationOverrideContextWindowLimit,
      setConversationOverrideModelSettings,
      setCurrentModelHandle,
      setCurrentModelId,
      setCurrentToolset,
      setCurrentToolsetPreference,
      setLlmConfig,
      setModelReasoningPrompt,
      setQueuedOverlayAction,
    ],
  );

  const handleSystemPromptSelect = useCallback(
    async (promptId: string, commandId?: string | null) => {
      const overlayCommand = commandId
        ? commandRunner.getHandle(commandId, "/system")
        : consumeOverlayCommand("system");

      let selectedPrompt:
        | { id: string; label: string; content: string }
        | undefined;

      try {
        const { SYSTEM_PROMPTS } = await import("@/agent/prompt-assets");
        selectedPrompt = SYSTEM_PROMPTS.find((p) => p.id === promptId);

        if (!selectedPrompt) {
          const cmd =
            overlayCommand ??
            commandRunner.start(
              "/system",
              `System prompt not found: ${promptId}`,
            );
          cmd.fail(`System prompt not found: ${promptId}`);
          return;
        }
        const prompt = selectedPrompt;

        if (isAgentBusy()) {
          setActiveOverlay(null);
          const cmd =
            overlayCommand ??
            commandRunner.start(
              "/system",
              "System prompt switch queued – will switch after current task completes",
            );
          cmd.update({
            output:
              "System prompt switch queued – will switch after current task completes",
            phase: "running",
          });
          setQueuedOverlayAction({
            type: "switch_system",
            promptId,
            commandId: cmd.id,
          });
          return;
        }

        await withCommandLock(async () => {
          const cmd =
            overlayCommand ??
            commandRunner.start(
              "/system",
              `Switching system prompt to ${prompt.label}...`,
            );
          cmd.update({
            output: `Switching system prompt to ${prompt.label}...`,
            phase: "running",
          });

          const { updateAgentSystemPrompt } = await import("@/agent/modify");
          const result = await updateAgentSystemPrompt(agentId, promptId);

          if (result.success) {
            setCurrentSystemPromptId(promptId);
            cmd.finish(`Switched system prompt to ${prompt.label}`, true);
          } else {
            cmd.fail(result.message);
          }
        });
      } catch (error) {
        const errorDetails = formatErrorDetails(error, agentId);
        const cmd =
          overlayCommand ??
          commandRunner.start("/system", "Failed to switch system prompt.");
        cmd.fail(`Failed to switch system prompt: ${errorDetails}`);
      }
    },
    [
      agentId,
      commandRunner,
      consumeOverlayCommand,
      isAgentBusy,
      withCommandLock,
      setActiveOverlay,
      setCurrentSystemPromptId,
      setQueuedOverlayAction,
    ],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: conversationIdRef is stable; .current is read dynamically during selection.
  const handlePersonalitySelect = useCallback(
    async (personalityId: PersonalityId, commandId?: string | null) => {
      const overlayCommand = commandId
        ? commandRunner.getHandle(commandId, "/personality")
        : consumeOverlayCommand("personality");

      const personality = getPersonalityOption(personalityId);

      if (!settingsManager.isMemfsEnabled(agentId)) {
        const cmd =
          overlayCommand ??
          commandRunner.start(
            "/personality",
            "Memory filesystem is disabled. Run /memfs enable first.",
          );
        cmd.fail("Memory filesystem is disabled. Run `/memfs enable` first.");
        return;
      }

      if (isAgentBusy()) {
        setActiveOverlay(null);
        const cmd =
          overlayCommand ??
          commandRunner.start(
            "/personality",
            "Personality switch queued – will apply after current task completes",
          );
        cmd.update({
          output:
            "Personality switch queued – will apply after current task completes",
          phase: "running",
        });
        setQueuedOverlayAction({
          type: "switch_personality",
          personalityId,
          commandId: cmd.id,
        });
        return;
      }

      try {
        await withCommandLock(async () => {
          const cmd =
            overlayCommand ??
            commandRunner.start(
              "/personality",
              `Switching personality to ${personality.label}...`,
            );
          cmd.update({
            output: `Switching personality to ${personality.label}...`,
            phase: "running",
          });

          const result = await applyPersonalityToMemory({
            agentId,
            personalityId,
          });

          if (!result.changed) {
            setCurrentPersonalityId(personalityId);
            cmd.finish(`Personality already set to ${personality.label}`, true);
            return;
          }

          setCurrentPersonalityId(personalityId);

          if (getBackend().capabilities.localMemfs) {
            cmd.update({
              output: "Recompiling local system prompt...",
              phase: "running",
            });
            const currentConversationId = conversationIdRef.current;
            await getBackend().recompileConversation(currentConversationId, {
              agent_id: agentId,
            });
            cmd.finish(
              `Personality swapped to ${personality.label}. Run \`/clear\` or \`/new\` to reset your message history for the personality to take full effect.`,
              true,
            );
            return;
          }

          // Wait for the remote block to pick up the git push
          cmd.update({
            output: "Waiting for changes to propagate...",
            phase: "running",
          });

          const expectedBlocks = new Map<string, string>([
            [
              "system/persona",
              getPersonalityBlockValues(personalityId).persona.trim(),
            ],
            [
              "system/human",
              getPersonalityBlockValues(personalityId).human.trim(),
            ],
          ]);
          const client = await getClient();
          const maxWaitMs = 300_000;
          const pollIntervalMs = 1_000;
          const start = Date.now();
          let propagated = false;

          while (Date.now() - start < maxWaitMs) {
            try {
              const blockPage = await client.agents.blocks.list(agentId);
              const missingLabels = Array.from(expectedBlocks.keys()).filter(
                (label) =>
                  !blockPage.items.some((block) => block.label === label),
              );
              if (missingLabels.length > 0) {
                throw new Error(
                  `${missingLabels.join(", ")} block not found on agent. Run \`/doctor\` to diagnose.`,
                );
              }

              const allBlocksPropagated = Array.from(
                expectedBlocks.entries(),
              ).every(([label, expectedContent]) =>
                blockPage.items.some(
                  (block) =>
                    block.label === label &&
                    block.value.includes(expectedContent),
                ),
              );
              if (allBlocksPropagated) {
                propagated = true;
                break;
              }
            } catch (pollErr) {
              if (
                pollErr instanceof Error &&
                pollErr.message.includes("not found on agent")
              ) {
                throw pollErr;
              }
              // Transient API error — keep polling
            }
            await new Promise((r) => setTimeout(r, pollIntervalMs));
          }

          if (propagated) {
            cmd.update({
              output: "Recompiling agent...",
              phase: "running",
            });

            const currentConversationId = conversationIdRef.current;
            await client.agents.recompile(agentId, {
              update_timestamp: true,
            });
            const conversationParams =
              currentConversationId === "default"
                ? { agent_id: agentId }
                : undefined;
            await client.conversations.recompile(
              currentConversationId,
              conversationParams,
            );

            cmd.finish(
              `Personality swapped to ${personality.label}. Run \`/clear\` or \`/new\` to reset your message history for the personality to take full effect.`,
              true,
            );
          } else {
            cmd.finish(
              `Personality swapped to ${personality.label}. Block propagation timed out — run \`/recompile\` manually`,
              true,
            );
          }
        });
      } catch (error) {
        const errorDetails = formatErrorDetails(error, agentId);
        const cmd =
          overlayCommand ??
          commandRunner.start("/personality", "Failed to switch personality.");
        cmd.fail(`Failed to switch personality: ${errorDetails}`);
      }
    },
    [
      agentId,
      commandRunner,
      consumeOverlayCommand,
      isAgentBusy,
      withCommandLock,
      setActiveOverlay,
      setCurrentPersonalityId,
      setQueuedOverlayAction,
    ],
  );

  const handleSleeptimeModeSelect = useCallback(
    async (
      reflectionSettings: ReflectionSettings,
      commandId?: string | null,
    ) => {
      const overlayCommand = commandId
        ? commandRunner.getHandle(commandId, "/sleeptime")
        : consumeOverlayCommand("sleeptime");

      if (isAgentBusy()) {
        setActiveOverlay(null);
        const cmd =
          overlayCommand ??
          commandRunner.start(
            "/sleeptime",
            "Sleeptime settings update queued – will apply after current task completes",
          );
        cmd.update({
          output:
            "Sleeptime settings update queued – will apply after current task completes",
          phase: "running",
        });
        setQueuedOverlayAction({
          type: "set_sleeptime",
          settings: reflectionSettings,
          commandId: cmd.id,
        });
        return;
      }

      await withCommandLock(async () => {
        const cmd =
          overlayCommand ??
          commandRunner.start("/sleeptime", "Saving sleeptime settings...");
        cmd.update({
          output: "Saving sleeptime settings...",
          phase: "running",
        });

        try {
          await persistReflectionSettingsForAgent(agentId, reflectionSettings);

          cmd.finish(
            `Updated sleeptime settings to: ${formatReflectionSettings(reflectionSettings)}`,
            true,
          );
        } catch (error) {
          const errorDetails = formatErrorDetails(error, agentId);
          cmd.fail(`Failed to save sleeptime settings: ${errorDetails}`);
        }
      });
    },
    [
      agentId,
      commandRunner,
      consumeOverlayCommand,
      isAgentBusy,
      withCommandLock,
      setActiveOverlay,
      setQueuedOverlayAction,
    ],
  );

  const handleCompactionModeSelect = useCallback(
    async (mode: string, commandId?: string | null) => {
      const overlayCommand = commandId
        ? commandRunner.getHandle(commandId, "/compaction")
        : consumeOverlayCommand("compaction");

      if (isAgentBusy()) {
        setActiveOverlay(null);
        const cmd =
          overlayCommand ??
          commandRunner.start(
            "/compaction",
            "Compaction settings update queued – will apply after current task completes",
          );
        cmd.update({
          output:
            "Compaction settings update queued – will apply after current task completes",
          phase: "running",
        });
        setQueuedOverlayAction({
          type: "set_compaction",
          mode,
          commandId: cmd.id,
        });
        return;
      }

      await withCommandLock(async () => {
        const cmd =
          overlayCommand ??
          commandRunner.start("/compaction", "Saving compaction settings...");
        cmd.update({
          output: "Saving compaction settings...",
          phase: "running",
        });

        try {
          // Spread existing compaction_settings to preserve model/other fields,
          // only override the mode. If no model is configured, default to
          // letta/auto so compaction uses a consistent summarization model.
          const existing = agentState?.compaction_settings;
          const existingModel = existing?.model?.trim();
          const nextCompactionSettings = {
            ...existing,
            model: existingModel || DEFAULT_SUMMARIZATION_MODEL,
            mode: mode as
              | "all"
              | "sliding_window"
              | "self_compact_all"
              | "self_compact_sliding_window",
          };

          await getBackend().updateAgent(agentId, {
            compaction_settings: nextCompactionSettings,
          });
          setAgentState((prev: AgentState | null | undefined) =>
            prev
              ? { ...prev, compaction_settings: nextCompactionSettings }
              : prev,
          );

          cmd.finish(`Updated compaction mode to: ${mode}`, true);
        } catch (error) {
          const errorDetails = formatErrorDetails(error, agentId);
          cmd.fail(`Failed to save compaction settings: ${errorDetails}`);
        }
      });
    },
    [
      agentId,
      commandRunner,
      consumeOverlayCommand,
      isAgentBusy,
      withCommandLock,
      agentState?.compaction_settings,
      setActiveOverlay,
      setAgentState,
      setQueuedOverlayAction,
    ],
  );

  const handleToolsetSelect = useCallback(
    async (toolsetId: ToolsetPreference, commandId?: string | null) => {
      const overlayCommand = commandId
        ? commandRunner.getHandle(commandId, "/toolset")
        : consumeOverlayCommand("toolset");

      if (isAgentBusy()) {
        setActiveOverlay(null);
        const cmd =
          overlayCommand ??
          commandRunner.start(
            "/toolset",
            "Toolset switch queued – will switch after current task completes",
          );
        cmd.update({
          output:
            "Toolset switch queued – will switch after current task completes",
          phase: "running",
        });
        setQueuedOverlayAction({
          type: "switch_toolset",
          toolsetId,
          commandId: cmd.id,
        });
        return;
      }

      await withCommandLock(async () => {
        const cmd =
          overlayCommand ??
          commandRunner.start("/toolset", "Switching toolset...");
        cmd.update({
          output: "Switching toolset...",
          phase: "running",
        });

        try {
          const { forceToolsetSwitch, switchToolsetForModel } = await import(
            "@/tools/toolset"
          );
          const previousToolsetSnapshot = currentToolset;
          const previousToolNamesSnapshot = getToolNames();

          if (toolsetId === "auto") {
            const modelHandle =
              currentModelHandle ??
              (llmConfig?.model_endpoint_type && llmConfig?.model
                ? `${llmConfig.model_endpoint_type}/${llmConfig.model}`
                : (llmConfig?.model ?? null));
            if (!modelHandle) {
              throw new Error(
                "Could not determine current model for auto toolset",
              );
            }

            const providerType =
              providerTypeFromModelSettings(agentState?.model_settings) ??
              llmConfig?.model_endpoint_type ??
              null;
            const derivedToolset = await switchToolsetForModel(
              modelHandle,
              agentId,
              providerType,
            );
            settingsManager.setToolsetPreference(agentId, "auto");
            setCurrentToolsetPreference("auto");
            setCurrentToolset(derivedToolset);
            maybeRecordToolsetChangeReminder({
              source: "/toolset",
              previousToolset: previousToolsetSnapshot,
              newToolset: derivedToolset,
              previousTools: previousToolNamesSnapshot,
              newTools: getToolNames(),
            });
            cmd.finish(
              `Toolset mode set to auto (currently ${formatToolsetName(derivedToolset)}).`,
              true,
            );
            return;
          }

          await forceToolsetSwitch(toolsetId, agentId);
          settingsManager.setToolsetPreference(agentId, toolsetId);
          setCurrentToolsetPreference(toolsetId);
          setCurrentToolset(toolsetId);
          maybeRecordToolsetChangeReminder({
            source: "/toolset",
            previousToolset: previousToolsetSnapshot,
            newToolset: toolsetId,
            previousTools: previousToolNamesSnapshot,
            newTools: getToolNames(),
          });
          cmd.finish(
            `Switched toolset to ${formatToolsetName(toolsetId)} (manual override)`,
            true,
          );
        } catch (error) {
          const errorDetails = formatErrorDetails(error, agentId);
          cmd.fail(`Failed to switch toolset: ${errorDetails}`);
        }
      });
    },
    [
      agentId,
      agentState?.model_settings,
      commandRunner,
      consumeOverlayCommand,
      currentToolset,
      currentModelHandle,
      isAgentBusy,
      llmConfig,
      maybeRecordToolsetChangeReminder,
      withCommandLock,
      setActiveOverlay,
      setCurrentToolset,
      setCurrentToolsetPreference,
      setQueuedOverlayAction,
    ],
  );

  const handleExperimentSelect = useCallback(
    async (
      selection: { experimentId: ExperimentId; enabled: boolean },
      commandId?: string | null,
    ) => {
      const overlayCommand = commandId
        ? commandRunner.getHandle(commandId, "/experiments")
        : consumeOverlayCommand("experiment");

      if (isAgentBusy()) {
        setActiveOverlay(null);
        const cmd =
          overlayCommand ??
          commandRunner.start(
            "/experiments",
            "Experiment toggle queued – will update after current task completes",
          );
        cmd.update({
          output:
            "Experiment toggle queued – will update after current task completes",
          phase: "running",
        });
        setQueuedOverlayAction({
          type: "set_experiment",
          experimentId: selection.experimentId,
          enabled: selection.enabled,
          commandId: cmd.id,
        });
        return;
      }

      await withCommandLock(async () => {
        const cmd =
          overlayCommand ??
          commandRunner.start("/experiments", "Updating experiment...");
        cmd.update({
          output: "Updating experiment...",
          phase: "running",
        });

        try {
          const snapshot = experimentManager.set(
            selection.experimentId,
            selection.enabled,
          );
          cmd.finish(
            `Experiment "${snapshot.label}" ${snapshot.enabled ? "enabled" : "disabled"}`,
            true,
          );
        } catch (error) {
          const errorDetails = formatErrorDetails(error, agentId);
          cmd.fail(`Failed to update experiment: ${errorDetails}`);
        } finally {
          setActiveOverlay(null);
        }
      });
    },
    [
      agentId,
      commandRunner,
      consumeOverlayCommand,
      isAgentBusy,
      withCommandLock,
      setActiveOverlay,
      setQueuedOverlayAction,
    ],
  );

  const handleExperimentsConfirm = useCallback(
    async (
      changes: Array<{ experimentId: ExperimentId; enabled: boolean }>,
    ) => {
      const overlayCommand = consumeOverlayCommand("experiment");

      if (changes.length === 0) {
        overlayCommand?.finish("Experiments dialog dismissed", true);
        setActiveOverlay(null);
        return;
      }

      if (isAgentBusy()) {
        setActiveOverlay(null);
        // For batch changes we can only queue one action; queue the first change.
        const first = changes[0];
        if (first) {
          const cmd =
            overlayCommand ??
            commandRunner.start(
              "/experiments",
              "Experiment changes queued – will update after current task completes",
            );
          cmd.update({
            output:
              "Experiment changes queued – will update after current task completes",
            phase: "running",
          });
          setQueuedOverlayAction({
            type: "set_experiment",
            experimentId: first.experimentId,
            enabled: first.enabled,
            commandId: cmd.id,
          });
        }
        return;
      }

      await withCommandLock(async () => {
        const cmd =
          overlayCommand ??
          commandRunner.start("/experiments", "Updating experiments...");
        cmd.update({ output: "Updating experiments...", phase: "running" });

        try {
          const results = changes.map(({ experimentId, enabled }) =>
            experimentManager.set(experimentId, enabled),
          );
          const summary = results
            .map((s) => `"${s.label}" ${s.enabled ? "enabled" : "disabled"}`)
            .join(", ");
          cmd.finish(`Experiments updated: ${summary}`, true);
        } catch (error) {
          const errorDetails = formatErrorDetails(error, agentId);
          cmd.fail(`Failed to update experiments: ${errorDetails}`);
        } finally {
          setActiveOverlay(null);
        }
      });
    },
    [
      agentId,
      commandRunner,
      consumeOverlayCommand,
      isAgentBusy,
      withCommandLock,
      setActiveOverlay,
      setQueuedOverlayAction,
    ],
  );

  return {
    handleModelSelect,
    handleSystemPromptSelect,
    handlePersonalitySelect,
    handleSleeptimeModeSelect,
    handleCompactionModeSelect,
    handleToolsetSelect,
    handleExperimentSelect,
    handleExperimentsConfirm,
  };
}
