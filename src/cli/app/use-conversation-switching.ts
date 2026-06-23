// src/cli/app/useConversationSwitching.ts

import { randomUUID } from "node:crypto";
import { APIError } from "@letta-ai/letta-client/core/error";
import type {
  AgentState,
  MessageCreate,
} from "@letta-ai/letta-client/resources/agents/agents";
import type { ApprovalCreate } from "@letta-ai/letta-client/resources/agents/messages";
import type { LlmConfig } from "@letta-ai/letta-client/resources/models/models";
import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useCallback,
} from "react";
import {
  extractConflictDetail,
  getPreStreamErrorAction,
  rebuildInputWithFreshDenials,
  STALE_APPROVAL_RECOVERY_DENIAL_REASON,
  shouldAttemptApprovalRecovery,
} from "@/agent/approval-recovery";
import { getResumeDataFromBackend } from "@/agent/check-approval";
import { createAgent } from "@/agent/create";
import { selectDefaultAgentModel } from "@/agent/defaults";
import { sendMessageStreamWithBackend } from "@/agent/message";
import {
  configureBackendMode,
  getBackend,
  isLocalBackendEnabled,
} from "@/backend";
import { getServerUrl } from "@/backend/api/client";
import type { BtwState } from "@/cli/components/BtwPane";
import {
  type Buffers,
  extractTextPart,
  type Line,
  toLines,
} from "@/cli/helpers/accumulator";
import { buildAgentReference } from "@/cli/helpers/app-urls";
import { backfillBuffers } from "@/cli/helpers/backfill";
import {
  type ContextTracker,
  resetContextHistory,
} from "@/cli/helpers/context-tracker";
import type { ConversationSwitchContext } from "@/cli/helpers/conversation-switch-alert";
import { formatErrorDetails } from "@/cli/helpers/error-formatter";
import { CLI_GLYPHS } from "@/cli/helpers/glyphs";
import type { ApprovalRequest } from "@/cli/helpers/stream";
import type { ModConversationCloseReason } from "@/cli/mods/types";
import type { LocalModAdapter } from "@/cli/mods/use-local-mod-adapter";
import { runSessionStartHooks } from "@/hooks";
import { updateProjectSettings } from "@/settings";
import { settingsManager } from "@/settings-manager";
import type { PreparedScopeToolContext } from "@/tools/toolset";
import { debugLog, debugWarn } from "@/utils/debug";

import { LLM_API_ERROR_MAX_RETRIES } from "./constants";
import { uid } from "./ids";
import { getPreferredAgentModelHandle } from "./model-config";
import type {
  ActiveOverlay,
  AppCommandRunner,
  OverlayCommandConsumer,
  QueuedOverlayAction,
  StaticItem,
} from "./types";

type ConversationSwitchingContext = {
  abortControllerRef: MutableRefObject<AbortController | null>;
  agentId: string;
  agentIdRef: MutableRefObject<string>;
  agentName: string | null;
  agentState: AgentState | null | undefined;
  buffersRef: MutableRefObject<Buffers>;
  commandRunner: AppCommandRunner;
  consumeOverlayCommand: OverlayCommandConsumer;
  contextTrackerRef: MutableRefObject<ContextTracker>;
  conversationGenerationRef: MutableRefObject<number>;
  conversationIdRef: MutableRefObject<string>;
  currentModelHandle: string | null;
  currentModelId: string | null;
  emittedIdsRef: MutableRefObject<Set<string>>;
  modAdapter: LocalModAdapter;
  hasBackfilledRef: MutableRefObject<boolean>;
  isAgentBusy: () => boolean;
  maybeCarryOverActiveConversationModel: (
    targetConversationId: string,
  ) => Promise<void>;
  pendingConversationSwitchRef: MutableRefObject<ConversationSwitchContext | null>;
  prepareScopedToolExecutionContext: (
    overrideModel?: string | null,
  ) => Promise<PreparedScopeToolContext>;
  recoverRestoredPendingApprovals: (
    approvals: ApprovalRequest[],
    options?: { notifyOnManualApproval?: boolean },
  ) => Promise<void>;
  resetBootstrapReminderState: (pendingConversationBootstrap?: boolean) => void;
  resetDeferredToolCallCommits: () => void;
  resetPendingReasoningCycle: () => void;
  resetTrajectoryBases: () => void;
  runEndHooks: (reason?: ModConversationCloseReason) => Promise<void>;
  sessionHooksRanRef: MutableRefObject<boolean>;
  sessionStartFeedbackRef: MutableRefObject<string[]>;
  setActiveOverlay: Dispatch<SetStateAction<ActiveOverlay>>;
  setAgentId: Dispatch<SetStateAction<string>>;
  setAgentState: Dispatch<SetStateAction<AgentState | null | undefined>>;
  setBtwState: Dispatch<SetStateAction<BtwState>>;
  setCommandRunning: (value: boolean) => void;
  setConversationAutoTitleEligibility: (enabled: boolean) => void;
  setConversationIdAndRef: (nextConversationId: string) => void;
  setConversationSummary: (summary: string | null) => void;
  setCurrentModelHandle: Dispatch<SetStateAction<string | null>>;
  setInterruptRequested: Dispatch<SetStateAction<boolean>>;
  setIsExecutingTool: Dispatch<SetStateAction<boolean>>;
  setLines: Dispatch<SetStateAction<Line[]>>;
  setLlmConfig: Dispatch<SetStateAction<LlmConfig | null>>;
  setPendingApprovals: Dispatch<SetStateAction<ApprovalRequest[]>>;
  setQueuedOverlayAction: Dispatch<SetStateAction<QueuedOverlayAction>>;
  setStaticItems: Dispatch<SetStateAction<StaticItem[]>>;
  setStaticRenderEpoch: Dispatch<SetStateAction<number>>;
  setStreaming: (value: boolean) => void;
  tempModelOverrideRef: MutableRefObject<string | null>;
  userCancelledRef: MutableRefObject<boolean>;
};

export function useConversationSwitching(ctx: ConversationSwitchingContext) {
  const {
    abortControllerRef,
    agentId,
    agentIdRef,
    agentName,
    agentState,
    buffersRef,
    commandRunner,
    consumeOverlayCommand,
    contextTrackerRef,
    conversationGenerationRef,
    conversationIdRef,
    currentModelHandle,
    currentModelId,
    emittedIdsRef,
    modAdapter,
    hasBackfilledRef,
    isAgentBusy,
    maybeCarryOverActiveConversationModel,
    pendingConversationSwitchRef,
    prepareScopedToolExecutionContext,
    recoverRestoredPendingApprovals,
    resetBootstrapReminderState,
    resetDeferredToolCallCommits,
    resetPendingReasoningCycle,
    resetTrajectoryBases,
    runEndHooks,
    sessionHooksRanRef,
    sessionStartFeedbackRef,
    setActiveOverlay,
    setAgentId,
    setAgentState,
    setBtwState,
    setCommandRunning,
    setConversationAutoTitleEligibility,
    setConversationIdAndRef,
    setConversationSummary,
    setCurrentModelHandle,
    setInterruptRequested,
    setIsExecutingTool,
    setLines,
    setLlmConfig,
    setPendingApprovals,
    setQueuedOverlayAction,
    setStaticItems,
    setStaticRenderEpoch,
    setStreaming,
    tempModelOverrideRef,
    userCancelledRef,
  } = ctx;

  // biome-ignore lint/correctness/useExhaustiveDependencies: conversation refs are stable objects; .current is read dynamically during the background turn.
  const handleBtwCommand = useCallback(
    async (question: string) => {
      debugLog("btw", "question=%s", question);

      if (!conversationIdRef.current) {
        debugWarn("btw", "no conversation to fork");
        return;
      }

      setBtwState({ status: "forking", question });

      try {
        const isDefault = conversationIdRef.current === "default";

        const backend = getBackend();

        // Fork the conversation
        const forked = await backend.forkConversation(
          conversationIdRef.current,
          {
            ...(isDefault ? { agentId } : {}),
          },
        );

        debugLog("btw", "forked conversationId=%s", forked.id);
        setBtwState((prev) => ({
          ...prev,
          status: "streaming",
          forkedConversationId: forked.id,
        }));

        let currentInput: Array<MessageCreate | ApprovalCreate> = [
          {
            role: "user",
            content: question,
            otid: randomUUID(),
          },
        ];
        let approvalRecoveryRetries = 0;
        let stream: Awaited<ReturnType<typeof sendMessageStreamWithBackend>>;

        while (true) {
          try {
            const preparedToolContext = await prepareScopedToolExecutionContext(
              tempModelOverrideRef.current ?? undefined,
            );
            stream = await sendMessageStreamWithBackend(
              backend,
              forked.id,
              currentInput,
              {
                overrideModel: tempModelOverrideRef.current ?? undefined,
                preparedToolContext: preparedToolContext.preparedToolContext,
              },
            );
            break;
          } catch (preStreamError) {
            debugLog(
              "btw",
              "Pre-stream error: %s (status=%s)",
              preStreamError instanceof Error
                ? preStreamError.message
                : String(preStreamError),
              preStreamError instanceof APIError
                ? preStreamError.status
                : "none",
            );

            const errorDetail = extractConflictDetail(preStreamError);
            const preStreamAction = getPreStreamErrorAction(errorDetail, 0, 0, {
              status:
                preStreamError instanceof APIError
                  ? preStreamError.status
                  : undefined,
              transientRetries: approvalRecoveryRetries,
              maxTransientRetries: 0,
            });

            if (
              shouldAttemptApprovalRecovery({
                approvalPendingDetected:
                  preStreamAction === "resolve_approval_pending",
                retries: approvalRecoveryRetries,
                maxRetries: LLM_API_ERROR_MAX_RETRIES,
              })
            ) {
              approvalRecoveryRetries += 1;
              try {
                const currentAgentId = agentIdRef.current ?? agentId;
                if (!currentAgentId) {
                  currentInput = rebuildInputWithFreshDenials(
                    currentInput,
                    [],
                    "",
                  );
                  continue;
                }

                const agent = await getBackend().retrieveAgent(currentAgentId);
                const { pendingApprovals: existingApprovals } =
                  await getResumeDataFromBackend(agent, forked.id);
                currentInput = rebuildInputWithFreshDenials(
                  currentInput,
                  existingApprovals ?? [],
                  STALE_APPROVAL_RECOVERY_DENIAL_REASON,
                );
              } catch {
                currentInput = rebuildInputWithFreshDenials(
                  currentInput,
                  [],
                  "",
                );
              }
              continue;
            }

            throw preStreamError;
          }
        }

        let responseText = "";
        for await (const chunk of stream) {
          if (chunk.message_type === "assistant_message") {
            const delta = extractTextPart(chunk.content);
            if (delta) {
              responseText += delta;
              setBtwState((prev) => ({
                ...prev,
                responseText,
              }));
            }
          }
        }

        setBtwState((prev) => ({
          ...prev,
          status: "complete",
          responseText,
        }));
      } catch (error) {
        debugWarn("btw", "failed: %s", error);
        setBtwState((prev) => ({
          ...prev,
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    },
    [agentId, prepareScopedToolExecutionContext, setBtwState],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: switch refs are stable objects; .current is read dynamically during the jump.
  const handleBtwJump = useCallback(
    async (conversationId: string) => {
      debugLog("btw", "jump to conversationId=%s", conversationId);

      // Clear btw state
      setBtwState({ status: "idle" });

      // Abort the current stream if running — bumping generation makes
      // processConversation bail out on its next iteration check.
      conversationGenerationRef.current += 1;
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
      userCancelledRef.current = true;
      setStreaming(false);
      setInterruptRequested(false);
      setIsExecutingTool(false);

      // Clear any pending approvals from the original conversation
      setPendingApprovals([]);

      // Switch to the forked conversation using existing pattern from /search
      resetPendingReasoningCycle();
      setCommandRunning(true);
      const previousConversationId = conversationIdRef.current;

      await runEndHooks("resume");

      try {
        if (!agentState) {
          throw new Error("Agent state not available");
        }

        const resumeData = await getResumeDataFromBackend(
          agentState,
          conversationId,
        );

        await maybeCarryOverActiveConversationModel(conversationId);
        setConversationIdAndRef(conversationId);
        setConversationAutoTitleEligibility(false);
        setConversationSummary(null);

        pendingConversationSwitchRef.current = {
          origin: "fork",
          conversationId,
          isDefault: false,
          messageCount: resumeData.messageHistory.length,
          messageHistory: resumeData.messageHistory,
        };

        settingsManager.persistSession(agentId, conversationId, process.cwd());

        // Clear current transcript and static items (same pattern as /search)
        buffersRef.current.byId.clear();
        buffersRef.current.order = [];
        buffersRef.current.tokenCount = 0;
        resetContextHistory(contextTrackerRef.current);
        resetBootstrapReminderState();
        emittedIdsRef.current.clear();
        resetDeferredToolCallCommits();
        setStaticItems([]);
        setStaticRenderEpoch((e) => e + 1);
        resetTrajectoryBases();

        // Backfill message history
        if (resumeData.messageHistory.length > 0) {
          hasBackfilledRef.current = false;
          backfillBuffers(buffersRef.current, resumeData.messageHistory);
          const backfilledItems: StaticItem[] = [];
          for (const id of buffersRef.current.order) {
            const ln = buffersRef.current.byId.get(id);
            if (!ln) continue;
            emittedIdsRef.current.add(id);
            backfilledItems.push({ ...ln } as StaticItem);
          }
          const separator = { kind: "separator" as const, id: uid("sep") };
          setStaticItems([separator, ...backfilledItems]);
          setLines(toLines(buffersRef.current));
          hasBackfilledRef.current = true;
        } else {
          setLines(toLines(buffersRef.current));
        }

        // Restore pending approvals if any
        if (resumeData.pendingApprovals.length > 0) {
          await recoverRestoredPendingApprovals(resumeData.pendingApprovals);
        }

        sessionHooksRanRef.current = false;
        runSessionStartHooks(
          true,
          agentId,
          agentName ?? undefined,
          conversationId,
        )
          .then((result) => {
            if (result.feedback.length > 0) {
              sessionStartFeedbackRef.current = result.feedback;
            }
          })
          .catch(() => {});
        sessionHooksRanRef.current = true;
        void modAdapter.events.emit(
          "conversation_open",
          {
            agentId,
            agentName: agentName ?? null,
            conversationId,
            previousConversationId,
            reason: "resume",
          },
          modAdapter.context,
        );

        setCommandRunning(false);

        // Allow dequeue after state updates flush
        setTimeout(() => {
          userCancelledRef.current = false;
        }, 50);
      } catch (error) {
        debugWarn("btw", "failed to jump to conversation: %s", error);
        setCommandRunning(false);
        userCancelledRef.current = false;
      }
    },
    [
      agentId,
      agentName,
      agentState,
      resetPendingReasoningCycle,
      runEndHooks,
      maybeCarryOverActiveConversationModel,
      resetBootstrapReminderState,
      setConversationAutoTitleEligibility,
      setConversationIdAndRef,
      setConversationSummary,
      setCommandRunning,
      setStreaming,
      recoverRestoredPendingApprovals,
      modAdapter,
      resetDeferredToolCallCommits,
      resetTrajectoryBases,
      abortControllerRef,
      conversationGenerationRef,
      hasBackfilledRef,
      pendingConversationSwitchRef,
      sessionHooksRanRef,
      sessionStartFeedbackRef,
      setBtwState,
      setInterruptRequested,
      setIsExecutingTool,
      setLines,
      setPendingApprovals,
      setStaticItems,
      setStaticRenderEpoch,
      userCancelledRef,
    ],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: switch refs are stable objects; .current is read dynamically during agent selection.
  const handleAgentSelect = useCallback(
    async (
      targetAgentId: string,
      opts?: {
        profileName?: string;
        conversationId?: string;
        commandId?: string;
        backendMode?: "local" | "api";
      },
    ) => {
      const overlayCommand = opts?.commandId
        ? commandRunner.getHandle(opts.commandId, "/agents")
        : consumeOverlayCommand("resume");

      // Close selector immediately
      setActiveOverlay(null);

      // Skip if already on this agent (no async work needed, queue can proceed)
      if (targetAgentId === agentId) {
        const label = agentName || targetAgentId.slice(0, 12);
        const cmd =
          overlayCommand ??
          commandRunner.start("/agents", `Already on "${label}"`);
        cmd.finish(`Already on "${label}"`, true);
        return;
      }

      // Drop any pending reasoning-tier debounce before switching contexts.
      resetPendingReasoningCycle();

      // If agent is busy, queue the switch for after end_turn
      if (isAgentBusy()) {
        const cmd =
          overlayCommand ??
          commandRunner.start(
            "/agents",
            "Agent switch queued – will switch after current task completes",
          );
        cmd.update({
          output:
            "Agent switch queued – will switch after current task completes",
          phase: "running",
        });
        setQueuedOverlayAction({
          type: "switch_agent",
          agentId: targetAgentId,
          commandId: cmd.id,
          backendMode: opts?.backendMode,
        });
        return;
      }

      // Lock input for async operation (set before any await to prevent queue processing)
      setCommandRunning(true);

      // Show loading indicator while switching
      const cmd =
        overlayCommand ?? commandRunner.start("/agents", "Switching agent...");
      cmd.update({ output: "Switching agent...", phase: "running" });

      // Track previous backend mode for rollback on failure
      const previousBackendMode = isLocalBackendEnabled() ? "local" : "api";
      let didSwitchBackend = false;

      try {
        // Switch backend if the target agent belongs to a different backend
        if (opts?.backendMode) {
          const currentIsLocal = isLocalBackendEnabled();
          const targetIsLocal = opts.backendMode === "local";
          if (currentIsLocal !== targetIsLocal) {
            configureBackendMode(opts.backendMode);
            didSwitchBackend = true;
          }
        }

        // Fetch new agent
        const agent = await getBackend().retrieveAgent(targetAgentId);

        // Use specified conversation or default to the agent's default conversation
        const targetConversationId = opts?.conversationId ?? "default";

        // Update project settings with new agent
        await updateProjectSettings({ lastAgent: targetAgentId });

        // Save the session (agent + conversation) to settings
        settingsManager.persistSession(targetAgentId, targetConversationId);

        // Clear current transcript and static items
        buffersRef.current.byId.clear();
        buffersRef.current.order = [];
        buffersRef.current.tokenCount = 0;
        emittedIdsRef.current.clear();
        resetDeferredToolCallCommits();
        setStaticItems([]);
        setStaticRenderEpoch((e) => e + 1);
        resetTrajectoryBases();

        // Update agent state - also update ref immediately for any code that runs before re-render
        agentIdRef.current = targetAgentId;
        setAgentId(targetAgentId);
        setAgentState(agent);
        setLlmConfig(agent.llm_config);
        const agentModelHandle = getPreferredAgentModelHandle(agent);
        setCurrentModelHandle(agentModelHandle);
        setConversationIdAndRef(targetConversationId);
        setConversationAutoTitleEligibility(false);
        setConversationSummary(null);

        // Ensure bootstrap reminders are re-injected on the first user turn
        // after switching to a different conversation/agent context.
        resetBootstrapReminderState();

        // Set conversation switch context for agent switch
        {
          const { getModelDisplayName } = await import("@/agent/model");
          const modelHandle =
            agent.model ||
            (agent.llm_config?.model_endpoint_type && agent.llm_config?.model
              ? `${agent.llm_config.model_endpoint_type}/${agent.llm_config.model}`
              : null);
          const modelLabel =
            (modelHandle && getModelDisplayName(modelHandle)) ||
            modelHandle ||
            "unknown";
          pendingConversationSwitchRef.current = {
            origin: "agent-switch",
            conversationId: targetConversationId,
            isDefault: targetConversationId === "default",
            agentSwitchContext: {
              name: agent.name || targetAgentId,
              description: agent.description ?? undefined,
              model: modelLabel,
              blockCount: agent.blocks?.length ?? 0,
            },
          };
        }

        // Reset context token tracking for new agent
        resetContextHistory(contextTrackerRef.current);

        // Build success message
        const agentLabel = agent.name || targetAgentId;
        const isSpecificConv =
          opts?.conversationId && opts.conversationId !== "default";
        const successOutput = isSpecificConv
          ? [
              `Switched to **${agentLabel}**`,
              `${CLI_GLYPHS.result}  Conversation: ${opts.conversationId}`,
            ].join("\n")
          : [
              `Resumed the default conversation with **${agentLabel}**.`,
              `${CLI_GLYPHS.result}  Type /resume to browse all conversations`,
              `${CLI_GLYPHS.result}  Type /new to start a new conversation`,
            ].join("\n");
        const separator = {
          kind: "separator" as const,
          id: uid("sep"),
        };
        setStaticItems([separator]);
        cmd.finish(successOutput, true);
      } catch (error) {
        // Rollback backend mode if we switched before the failure
        if (didSwitchBackend) {
          configureBackendMode(previousBackendMode);
        }
        const errorDetails = formatErrorDetails(error, agentId);
        cmd.fail(`Failed: ${errorDetails}`);
      } finally {
        setCommandRunning(false);
      }
    },
    [
      agentId,
      agentName,
      commandRunner,
      consumeOverlayCommand,
      setCommandRunning,
      isAgentBusy,
      resetDeferredToolCallCommits,
      resetTrajectoryBases,
      resetBootstrapReminderState,
      resetPendingReasoningCycle,
      setConversationAutoTitleEligibility,
      setConversationIdAndRef,
      setConversationSummary,
      agentIdRef,
      pendingConversationSwitchRef,
      setActiveOverlay,
      setAgentId,
      setAgentState,
      setCurrentModelHandle,
      setLlmConfig,
      setQueuedOverlayAction,
      setStaticItems,
      setStaticRenderEpoch,
    ],
  );

  // Handle creating a new agent and switching to it
  // biome-ignore lint/correctness/useExhaustiveDependencies: switch refs are stable objects; .current is read dynamically during agent creation.
  const handleCreateNewAgent = useCallback(
    async (
      name: string,
      opts?: { commandId?: string; backendMode?: "local" | "api" },
    ) => {
      // Close dialog immediately
      setActiveOverlay(null);

      // Lock input for async operation
      setCommandRunning(true);

      const cmd = opts?.commandId
        ? commandRunner.getHandle(opts.commandId, "/new")
        : commandRunner.start("/new", `Creating agent "${name}"...`);
      cmd.update({ output: `Creating agent "${name}"...`, phase: "running" });

      const previousBackendMode = isLocalBackendEnabled() ? "local" : "api";
      let didSwitchBackend = false;

      try {
        if (opts?.backendMode && opts.backendMode !== previousBackendMode) {
          configureBackendMode(opts.backendMode);
          didSwitchBackend = true;
        }

        // Pre-determine memfs mode so the agent is created with the correct prompt.
        const { isLettaCloud, enableMemfsIfCloud } = await import(
          "@/agent/memory-filesystem"
        );
        const backend = getBackend();
        const willAutoEnableMemfs = await isLettaCloud();

        let effectiveModel = didSwitchBackend
          ? undefined
          : currentModelId || currentModelHandle || undefined;
        const isSelfHosted = !getServerUrl().includes("api.letta.com");
        if (isSelfHosted) {
          try {
            const availableHandles = (await backend.listModels())
              .map((model) => model.handle)
              .filter((handle): handle is string => typeof handle === "string");
            effectiveModel = selectDefaultAgentModel({
              preferredModel: effectiveModel,
              isSelfHosted: true,
              availableHandles,
            });
          } catch {
            effectiveModel = selectDefaultAgentModel({
              preferredModel: effectiveModel,
              isSelfHosted: true,
            });
          }
        }

        // Create the new agent
        const { agent } = await createAgent({
          name,
          model: effectiveModel,
          memoryPromptMode: backend.capabilities.localMemfs
            ? "local-memfs"
            : willAutoEnableMemfs
              ? "memfs"
              : undefined,
        });

        // Enable memfs on Letta Cloud (tags, repo clone, tool detach)
        // without blocking the new-agent UX on the initial clone.
        void enableMemfsIfCloud(agent.id);

        // Update project settings with new agent
        await updateProjectSettings({ lastAgent: agent.id });

        // New agents always start on their default conversation route.
        // Persist this explicitly so routing and resume state do not retain
        // a previous agent's non-default conversation id.
        const targetConversationId = "default";
        settingsManager.persistSession(agent.id, targetConversationId);

        // Build success message with hints
        const agentUrl = buildAgentReference(agent.id);
        const memfsTip =
          "Tip: use /init to initialize your agent's memory system!";
        const successOutput = [
          `Created **${agent.name || agent.id}** (use /pin to save)`,
          `${CLI_GLYPHS.result}  ${agentUrl}`,
          `${CLI_GLYPHS.result}  ${memfsTip}`,
        ].join("\n");
        // Clear current transcript and static items
        buffersRef.current.byId.clear();
        buffersRef.current.order = [];
        buffersRef.current.tokenCount = 0;
        emittedIdsRef.current.clear();
        resetDeferredToolCallCommits();
        setStaticItems([]);
        setStaticRenderEpoch((e) => e + 1);
        resetTrajectoryBases();

        // Update agent state
        agentIdRef.current = agent.id;
        setAgentId(agent.id);
        setAgentState(agent);
        setLlmConfig(agent.llm_config);
        const agentModelHandle = getPreferredAgentModelHandle(agent);
        setCurrentModelHandle(agentModelHandle);
        setConversationIdAndRef(targetConversationId);
        setConversationAutoTitleEligibility(false);
        setConversationSummary(null);

        // Set conversation switch context for new agent switch
        pendingConversationSwitchRef.current = {
          origin: "agent-switch",
          conversationId: targetConversationId,
          isDefault: true,
          agentSwitchContext: {
            name: agent.name || agent.id,
            description: agent.description ?? undefined,
            model: agentModelHandle
              ? (await import("@/agent/model")).getModelDisplayName(
                  agentModelHandle,
                ) || agentModelHandle
              : "unknown",
            blockCount: agent.blocks?.length ?? 0,
          },
        };

        // Reset context token tracking for new agent
        resetContextHistory(contextTrackerRef.current);

        // Ensure bootstrap reminders are re-injected after creating a new agent.
        resetBootstrapReminderState(true);

        const separator = {
          kind: "separator" as const,
          id: uid("sep"),
        };

        setStaticItems([separator]);
        cmd.finish(successOutput, true);
      } catch (error) {
        if (didSwitchBackend) {
          configureBackendMode(previousBackendMode);
        }
        const errorDetails = formatErrorDetails(error, agentId);
        cmd.fail(`Failed to create agent: ${errorDetails}`);
      } finally {
        setCommandRunning(false);
      }
    },
    [
      agentId,
      commandRunner,
      currentModelHandle,
      currentModelId,
      setCommandRunning,
      resetDeferredToolCallCommits,
      resetTrajectoryBases,
      resetBootstrapReminderState,
      setConversationAutoTitleEligibility,
      setConversationIdAndRef,
      setConversationSummary,
      agentIdRef,
      pendingConversationSwitchRef,
      setActiveOverlay,
      setAgentId,
      setAgentState,
      setCurrentModelHandle,
      setLines,
      setLlmConfig,
      setStaticItems,
      setStaticRenderEpoch,
    ],
  );

  return {
    handleBtwCommand,
    handleBtwJump,
    handleAgentSelect,
    handleCreateNewAgent,
  };
}
