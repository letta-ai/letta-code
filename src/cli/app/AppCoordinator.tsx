import { join } from "node:path";
import type {
  AgentState,
  MessageCreate,
} from "@letta-ai/letta-client/resources/agents/agents";
import type { ApprovalCreate } from "@letta-ai/letta-client/resources/agents/messages";
import type { LlmConfig } from "@letta-ai/letta-client/resources/models/models";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ApprovalResult } from "@/agent/approval-execution";
import { prefetchAvailableModelHandles } from "@/agent/available-models";
import { getResumeDataFromBackend } from "@/agent/check-approval";
import { setCurrentAgentId } from "@/agent/context";
import { regenerateConversationDescription } from "@/agent/conversation-description";
import { buildConversationModelCarryoverUpdate } from "@/agent/conversation-model-carryover";
import { getScopedMemoryFilesystemRoot } from "@/agent/memory-filesystem";
import { isActiveMemfsEnabled } from "@/agent/memory-runtime";
import {
  CHATGPT_FAST_SERVICE_TIER,
  getChatGptFastRegistryHandleForModelHandle,
  getModelInfoForLlmConfig,
  getModelShortName,
  type ModelReasoningEffort,
  type ModelReasoningSelection,
} from "@/agent/model";
import type { PersonalityId } from "@/agent/personality-presets";
import { shouldRecommendDefaultPrompt } from "@/agent/prompt-assets";
import { reconcileExistingAgentState } from "@/agent/reconcile-existing-agent-state";
import { prefetchModelCatalog } from "@/agent/remote-model-catalog";
import { recordSessionEnd } from "@/agent/session-history";
import { SessionStats } from "@/agent/stats";
import {
  clearSubagentsByIds,
  getActiveBackgroundAgents,
  getSubagentByToolCallId,
  getSnapshot as getSubagentSnapshot,
  hasStopFailedSubagents,
  subscribe as subscribeToSubagents,
} from "@/agent/subagent-state";
import { getBackend, isLocalBackendEnabled } from "@/backend";
import { getClient } from "@/backend/api/client";
import { getBillingTier } from "@/backend/api/metadata";
import { subscribePiProviderRegistry } from "@/backend/dev/pi-provider-mod-registry";
import { useConversationTitleSync } from "@/cli/app/conversation-title-sync";
import {
  cancelActiveConnectOperation,
  isActiveConnectOperationCancellable,
} from "@/cli/commands/connect-command-state";
import { refreshCustomCommands } from "@/cli/commands/custom";
import {
  type CommandFinishedEvent,
  type CommandHandle,
  createCommandRunner,
} from "@/cli/commands/runner";
import type { BtwState } from "@/cli/components/BtwPane";
import type { ModelSelectorSelection } from "@/cli/components/ModelSelector";
import { TerminalTitleWriter } from "@/cli/components/TerminalTitleWriter";
import {
  appendStreamingOutput,
  type Buffers,
  createBuffers,
  type Line,
  toLines,
} from "@/cli/helpers/accumulator";
import { isLocalAgentId } from "@/cli/helpers/app-urls";
import { backfillBuffers } from "@/cli/helpers/backfill";
import { chunkLog } from "@/cli/helpers/chunk-log";
import { buildCliModContext } from "@/cli/helpers/cli-mod-context";
import {
  createContextTracker,
  resetContextHistory,
} from "@/cli/helpers/context-tracker";
import {
  generateConversationTitleFromSummary,
  getConversationTitleSettings,
  listConversationTitleMessages,
  normalizeConversationTitle,
} from "@/cli/helpers/conversation-title";
import type { AdvancedDiffSuccess } from "@/cli/helpers/diff";
import { setErrorContext } from "@/cli/helpers/error-context";
import { formatErrorDetails } from "@/cli/helpers/error-formatter";
import { parsePatchOperations } from "@/cli/helpers/format-args-display";
import { CLI_GLYPHS } from "@/cli/helpers/glyphs";
import { getReflectionSettings } from "@/cli/helpers/memory-reminder";
import type { ExecutionPhase } from "@/cli/helpers/phase-visuals";
import { maybeLaunchPostTurnReflection } from "@/cli/helpers/post-turn-reflection";
import {
  buildReflectionArenaChoiceQuestions,
  finalizeReflectionArenaChoice,
  formatReflectionArenaDeferredMessage,
  parseReflectionArenaChoiceAnswers,
  REFLECTION_ARENA_MODEL_A_DEFAULT,
  type ReflectionArenaChoiceQuestion,
  sampleReflectionArenaComparisonModel,
} from "@/cli/helpers/reflection-arena";
import { launchReflectionArena } from "@/cli/helpers/reflection-arena-launcher";
import {
  AUTO_REFLECTION_DESCRIPTION,
  launchReflectionSubagent,
} from "@/cli/helpers/reflection-launcher";
import { safeJsonParseOr } from "@/cli/helpers/safe-json-parse";
import { getStartupModelDisplayOverride } from "@/cli/helpers/startup-model-display";
import type { ApprovalRequest } from "@/cli/helpers/stream";
import {
  collectFinishedTaskToolCalls,
  createSubagentGroupItem,
  hasInProgressTaskToolCalls,
} from "@/cli/helpers/subagent-aggregation";
import { buildStartupSystemPromptWarning } from "@/cli/helpers/system-prompt-warning.ts";
import { getRandomThinkingVerb } from "@/cli/helpers/thinking-messages";
import {
  isFileEditTool,
  isFileWriteTool,
  isPatchTool,
  isShellOutputTool,
  isShellTool,
} from "@/cli/helpers/tool-name-mapping";
import { isTaskTool } from "@/cli/helpers/tool-name-mapping.js";
import { getTuiBlockedReason } from "@/cli/helpers/tui-queue-adapter";
import {
  prepareTuiQueueSubmit,
  toTuiQueuedMessage,
} from "@/cli/helpers/tui-queue-input";
import { createTuiQueueRuntime } from "@/cli/helpers/tui-queue-runtime";
import type { WindowTitleData } from "@/cli/helpers/window-title-config";
import { useSyncedState } from "@/cli/hooks/use-synced-state";
import {
  useTerminalRows,
  useTerminalWidth,
} from "@/cli/hooks/use-terminal-width";
import { useSuspend } from "@/cli/hooks/useSuspend/use-suspend.ts";
import { installLocalBackendModEventHooks } from "@/cli/mods/local-backend-mod-events";
import type { ModConversationCloseReason } from "@/cli/mods/types";
import {
  type LocalModAdapter,
  useLocalModAdapter,
} from "@/cli/mods/use-local-mod-adapter";
import {
  getIntendedCronOccurrence,
  getTask,
  handleTaskPreflight,
  hasLiveSchedulerOwner,
  readCronFile,
  safeAppendCronRunLogForTask,
  shouldFireTask,
  updateTask,
  wrapCronPrompt,
} from "@/cron";
import { experimentManager } from "@/experiments/manager";
import { runSessionEndHooks, runSessionStartHooks } from "@/hooks";
import type { ApprovalContext } from "@/permissions/analyzer";
import { type PermissionMode, permissionMode } from "@/permissions/mode";
import {
  buildByokProviderAliases,
  isByokHandleForSelector,
  listProviders,
} from "@/providers/byok-providers";
import type {
  MessageQueueItem,
  QueueRuntime,
  TaskNotificationQueueItem,
} from "@/queue/queue-runtime";
import {
  createSharedReminderState,
  enqueueCommandIoReminder,
  enqueueToolsetChangeReminder,
  resetSharedReminderState,
  type SharedReminderState,
} from "@/reminders/state";
import { getCurrentWorkingDirectory } from "@/runtime-context";
import { settingsManager } from "@/settings-manager";
import { telemetry } from "@/telemetry";
import {
  releaseToolExecutionContext,
  type ToolExecutionResult,
} from "@/tools/manager";
import {
  deriveToolsetFromModel,
  prepareToolExecutionContextForResolvedTarget,
  prepareToolExecutionContextForScope,
  type ToolsetName,
  type ToolsetPreference,
} from "@/tools/toolset";
import {
  debugLog,
  debugLogFile,
  debugWarn,
  isDebugEnabled,
} from "@/utils/debug";
import {
  addToMessageQueue,
  type QueuedMessage,
  setMessageQueueAdder,
} from "@/utils/message-queue-bridge";
import {
  appendTaskNotificationEventsToBuffer,
  selectStopFailedNotifications,
} from "@/utils/task-notifications";
import { recordTuiPerf } from "@/utils/tui-perf";
import { getVersion } from "@/version";
import { AppView } from "./AppView";
import {
  ANIMATION_RESUME_HYSTERESIS_ROWS,
  APPROVAL_OPTIONS_HEIGHT,
  APPROVAL_PREVIEW_BUFFER,
  CLEAR_SCREEN_AND_HOME,
  DIFF_WRAP_GUTTER,
  MIN_CLEAR_INTERVAL_MS,
  MIN_RESIZE_DELTA,
  MIN_WRAP_WIDTH,
  RESIZE_SETTLE_MS,
  SHELL_PREVIEW_MAX_LINES,
  STABLE_WIDTH_SETTLE_MS,
  TEXT_WRAP_GUTTER,
  TOOL_CALL_COMMIT_DEFER_MS,
} from "./constants";
import { uid } from "./ids";
import {
  countWrappedLines,
  countWrappedLinesFromList,
  estimateAdvancedDiffLines,
} from "./layout";
import {
  buildModelHandleFromLlmConfig,
  deriveReasoningEffort,
  getPreferredAgentModelHandle,
  inferReasoningEffortFromModelPreset,
  mapHandleToLlmConfigPatch,
  providerTypeFromModelSettings,
  reasoningEffortLlmConfigPatch,
} from "./model-config";
import { prepareSessionExit } from "./session";
import type {
  ActiveOverlay,
  AppProps,
  QueuedOverlayAction,
  StaticItem,
} from "./types";
import { closeMcp, useMcpCleanup } from "./use-agent-mcp-servers";
import { useApprovalFlow } from "./use-approval-flow";
import { useBashHandlers } from "./use-bash-handlers";
import { useConfigurationHandlers } from "./use-configuration-handlers";
import { useConversationLoop } from "./use-conversation-loop";
import { useConversationSwitching } from "./use-conversation-switching";
import { useFeedbackHandler } from "./use-feedback-handler";
import { useInterruptHandler } from "./use-interrupt-handler";
import { useQueuedApprovalSubmit } from "./use-queued-approval-submit";
import { useReasoningCycle } from "./use-reasoning-cycle";
import { useSubmitHandler } from "./use-submit-handler";

function buildStartupCommandHints(options: {
  isResumingConversation: boolean;
  isPinned: boolean;
  isLocalBackend: boolean;
  hasMessages: boolean;
  hasCloudCredentials: boolean;
  hasAvailableLocalModels: boolean;
}): string[] {
  const {
    isResumingConversation,
    isPinned,
    isLocalBackend,
    hasMessages,
    hasCloudCredentials,
    hasAvailableLocalModels,
  } = options;

  const baseHints = isResumingConversation
    ? [
        "→ **/agents**    list all agents",
        "→ **/resume**    browse all conversations",
        "→ **/new**       start a new conversation",
        "→ **/init**      initialize your agent's memory",
      ]
    : isPinned
      ? [
          "→ **/agents**    list all agents",
          "→ **/resume**    resume a previous conversation",
          "→ **/memory**    view your agent's memory",
          "→ **/init**      initialize your agent's memory",
        ]
      : [
          "→ **/agents**    list all agents",
          "→ **/resume**    resume a previous conversation",
          "→ **/pin**       save + name your agent",
          "→ **/init**      initialize your agent's memory",
        ];

  const onboardingHints: string[] = [];

  if (isLocalBackend && !hasAvailableLocalModels) {
    onboardingHints.push(
      "→ **/model**     switch models",
      "→ **/connect**   configure your llm api keys",
    );
  }

  if (!hasMessages) {
    onboardingHints.push(
      "→ **/rename**    name your agent",
      "→ **/init**      initialize your agent's memory",
    );
  }

  if (!hasCloudCredentials) {
    onboardingHints.push("→ **/login**     sign in with Letta");
  }

  const dedupedHints: string[] = [];
  const seenHints = new Set<string>();

  for (const hint of [...onboardingHints, ...baseHints]) {
    if (seenHints.has(hint)) {
      continue;
    }
    seenHints.add(hint);
    dedupedHints.push(hint);
    if (dedupedHints.length === 5) {
      break;
    }
  }

  return dedupedHints;
}

function hasConversationContent(lines: Line[]): boolean {
  return lines.some((line) => {
    switch (line.kind) {
      case "user":
      case "assistant":
      case "reasoning":
      case "tool_call":
      case "error":
      case "command":
      case "bash_command":
        return true;
      default:
        return false;
    }
  });
}

export function App({
  agentId: initialAgentId,
  agentState: initialAgentState,
  conversationId: initialConversationId,
  loadingState = "ready",
  continueSession = false,
  startupApproval = null,
  startupApprovals = [],
  messageHistory = [],
  resumedExistingConversation = false,
  startupConversationTitleEligible = false,
  tokenStreaming = false,
  reasoningTabCycleEnabled: initialReasoningTabCycleEnabled = false,
  showCompactions = false,
  agentProvenance = null,
  startupHasCloudCredentials = false,
  startupHasAvailableLocalModels = true,
  fileAutocompleteFdPath = null,
  releaseNotes = null,
  updateNotification = null,
  systemInfoReminderEnabled = true,
  modsDisabled = false,
}: AppProps) {
  useEffect(() => {
    prefetchAvailableModelHandles();
    prefetchModelCatalog();
  }, []);

  const [hasAvailableLocalModels, setHasAvailableLocalModels] = useState(
    startupHasAvailableLocalModels,
  );
  const markLocalModelsAvailable = useCallback(() => {
    setHasAvailableLocalModels(true);
  }, []);

  const [agentId, setAgentId] = useState(initialAgentId);
  const [agentState, setAgentState] = useState(initialAgentState);

  const updateAgentName = useCallback((name: string) => {
    setAgentState((prev) => (prev ? { ...prev, name } : prev));
  }, []);

  const includeSystemPromptUpgradeTip = useMemo(() => {
    if (!agentState?.id || !agentState.system) return false;
    const memMode = settingsManager.isMemfsEnabled(agentState.id)
      ? "memfs"
      : ("standard" as const);
    return shouldRecommendDefaultPrompt(agentState.system, memMode);
  }, [agentState]);

  const projectDirectory = process.cwd();
  const [conversationId, setConversationId] = useState(initialConversationId);
  const [conversationSummary, setConversationSummary] = useState<string | null>(
    null,
  );
  const agentIdRef = useRef(agentId);
  useEffect(() => {
    agentIdRef.current = agentId;
    telemetry.setCurrentAgentId(agentId);
  }, [agentId]);

  const conversationIdRef = useRef(conversationId);
  useEffect(() => {
    conversationIdRef.current = conversationId;
  }, [conversationId]);
  const setConversationIdAndRef = useCallback((nextConversationId: string) => {
    conversationIdRef.current = nextConversationId;
    setConversationId(nextConversationId);
  }, []);

  const pendingTranscriptStartLineIndexRef = useRef<number | null>(null);

  const lastRunIdRef = useRef<string | null>(null);

  const resumeKey = useSuspend();

  const pendingConversationSwitchRef = useRef<
    | import("@/cli/helpers/conversation-switch-alert").ConversationSwitchContext
    | null
  >(null);

  const prevInitialAgentIdRef = useRef(initialAgentId);
  const prevInitialAgentStateRef = useRef(initialAgentState);
  const prevInitialConversationIdRef = useRef(initialConversationId);

  useEffect(() => {
    if (initialAgentId !== prevInitialAgentIdRef.current) {
      prevInitialAgentIdRef.current = initialAgentId;
      agentIdRef.current = initialAgentId;
      setAgentId(initialAgentId);
    }
  }, [initialAgentId]);

  useEffect(() => {
    if (initialAgentState !== prevInitialAgentStateRef.current) {
      prevInitialAgentStateRef.current = initialAgentState;
      setAgentState(initialAgentState);
    }
  }, [initialAgentState]);

  useEffect(() => {
    if (initialConversationId !== prevInitialConversationIdRef.current) {
      prevInitialConversationIdRef.current = initialConversationId;
      setConversationIdAndRef(initialConversationId);
    }
  }, [initialConversationId, setConversationIdAndRef]);

  useEffect(() => {
    if (agentId) {
      setCurrentAgentId(agentId);
    }
  }, [agentId]);

  const [streaming, setStreaming, streamingRef] = useSyncedState(false);
  const [networkPhase, setNetworkPhase] = useState<
    "upload" | "download" | "error" | null
  >(null);
  const [executionPhase, setExecutionPhase] = useState<ExecutionPhase>(null);
  const [uiPermissionMode, _setUiPermissionMode] = useState(
    permissionMode.getMode(),
  );
  const uiPermissionModeRef = useRef<PermissionMode>(uiPermissionMode);

  const [expandedToolCallId, setExpandedToolCallId] = useState<string | null>(
    null,
  );

  const setUiPermissionMode = useCallback((mode: PermissionMode) => {
    uiPermissionModeRef.current = mode;
    _setUiPermissionMode(mode);

    if (permissionMode.getMode() !== mode) {
      permissionMode.setMode(mode);
    }
  }, []);

  useEffect(() => {
    if (!streaming) {
      setNetworkPhase(null);
      setExecutionPhase(null);
    }
  }, [streaming]);

  // Guard ref for preventing concurrent processConversation calls
  const processingConversationRef = useRef(0),
    staleTurnUnwindingRef = useRef(false),
    releasedGenerationRef = useRef<number | null>(null);
  // Generation counter - incremented on each ESC interrupt.
  const conversationGenerationRef = useRef(0);
  const [interruptRequested, setInterruptRequested] = useState(false);
  // Whether a command is running (disables input but no streaming UI)
  // Uses synced state to keep ref in sync for reliable async checks
  const [commandRunning, setCommandRunning, commandRunningRef] =
    useSyncedState(false);
  // Profile load confirmation - when loading a profile and current agent is unsaved
  const [profileConfirmPending, setProfileConfirmPending] = useState<{
    name: string;
    agentId: string;
    cmdId: string;
  } | null>(null);
  const [worktreeDiffSelectorPending, setWorktreeDiffSelectorPending] =
    useState<{
      worktrees: import("@/web/worktree-diff-list").WorktreeDiffOption[];
    } | null>(null);
  const [reflectionArenaChoicePending, setReflectionArenaChoicePending] =
    useState<{
      questions: ReflectionArenaChoiceQuestion[];
      runId: string;
    } | null>(null);

  const [pendingApprovals, setPendingApprovals] = useState<ApprovalRequest[]>(
    [],
  );
  const [approvalContexts, setApprovalContexts] = useState<ApprovalContext[]>(
    [],
  );

  const [btwState, setBtwState] = useState<BtwState>({ status: "idle" });

  const [approvalResults, setApprovalResults] = useState<
    Array<
      | { type: "approve"; approval: ApprovalRequest }
      | { type: "deny"; approval: ApprovalRequest; reason: string }
    >
  >([]);
  const [isExecutingTool, setIsExecutingTool] = useState(false);
  const [queuedApprovalResults, setQueuedApprovalResults] = useState<
    ApprovalResult[] | null
  >(null);
  const queuedApprovalResultsRef = useRef<ApprovalResult[] | null>(null);
  const toolAbortControllerRef = useRef<AbortController | null>(null);

  const [bashRunning, setBashRunning] = useState(false);
  const bashAbortControllerRef = useRef<AbortController | null>(null);

  const [needsEagerApprovalCheck, setNeedsEagerApprovalCheck] = useState(
    () => resumedExistingConversation || startupApprovals.length > 0,
  );

  const [autoHandledResults, setAutoHandledResults] = useState<
    Array<{
      toolCallId: string;
      result: ToolExecutionResult;
    }>
  >([]);
  const [autoDeniedApprovals, setAutoDeniedApprovals] = useState<
    Array<{
      approval: ApprovalRequest;
      reason: string;
    }>
  >([]);
  const executingToolCallIdsRef = useRef<string[]>([]);
  const interruptQueuedRef = useRef(false);
  const toolResultsInFlightRef = useRef(false);
  const autoAllowedExecutionRef = useRef<{
    toolCallIds: string[];
    results: ApprovalResult[] | null;
    conversationId: string;
    generation: number;
  } | null>(null);
  const restoredApprovalRecoveryRef = useRef<{
    batchKey: string | null;
    generation: number;
    status: "idle" | "running" | "completed";
  }>({
    batchKey: null,
    generation: -1,
    status: "idle",
  });
  const queuedApprovalMetadataRef = useRef<{
    conversationId: string;
    generation: number;
  } | null>(null);

  const queueApprovalResults = useCallback(
    (
      results: ApprovalResult[] | null,
      metadata?: { conversationId: string; generation: number },
    ) => {
      queuedApprovalResultsRef.current = results;
      setQueuedApprovalResults(results);
      if (results) {
        queuedApprovalMetadataRef.current = metadata ?? {
          conversationId: conversationIdRef.current,
          generation: conversationGenerationRef.current,
        };
      } else {
        queuedApprovalMetadataRef.current = null;
      }
    },
    [],
  );

  const bashCommandCacheRef = useRef<Array<{ input: string; output: string }>>(
    [],
  );

  const currentApproval = pendingApprovals[approvalResults.length];
  const currentApprovalContext = approvalContexts[approvalResults.length];
  const activeApprovalId = currentApproval?.toolCallId ?? null;

  const {
    pendingIds,
    queuedIds,
    approvalMap,
    stubDescriptions,
    queuedDecisions,
  } = useMemo(() => {
    const pending = new Set<string>();
    const queued = new Set<string>();
    const map = new Map<string, ApprovalRequest>();
    const descriptions = new Map<string, string>();
    const decisions = new Map<
      string,
      { type: "approve" | "deny"; reason?: string }
    >();

    const computeStubDescription = (
      approval: ApprovalRequest,
    ): string | undefined => {
      try {
        const args = JSON.parse(approval.toolArgs || "{}");

        if (
          isFileEditTool(approval.toolName) ||
          isFileWriteTool(approval.toolName)
        ) {
          return args.file_path || undefined;
        }
        if (isShellTool(approval.toolName)) {
          const cmd = (() => {
            if (typeof args.cmd === "string") return args.cmd;
            if (typeof args.command === "string") return args.command;
            if (Array.isArray(args.command)) return args.command.join(" ");
            if (
              approval.toolName === "write_stdin" &&
              (typeof args.session_id === "string" ||
                typeof args.session_id === "number")
            ) {
              return `write_stdin ${String(args.session_id)}`;
            }
            return "";
          })();
          return cmd.length > 50 ? `${cmd.slice(0, 50)}...` : cmd || undefined;
        }
        if (isPatchTool(approval.toolName)) {
          return "patch operation";
        }
        return undefined;
      } catch {
        return undefined;
      }
    };

    const activeIndex = approvalResults.length;

    for (let i = 0; i < pendingApprovals.length; i++) {
      const approval = pendingApprovals[i];
      if (!approval?.toolCallId || approval.toolCallId === activeApprovalId) {
        continue;
      }

      const id = approval.toolCallId;
      map.set(id, approval);

      const desc = computeStubDescription(approval);
      if (desc) {
        descriptions.set(id, desc);
      }

      if (i < activeIndex) {
        queued.add(id);
        const result = approvalResults[i];
        if (result) {
          decisions.set(id, {
            type: result.type,
            reason: result.type === "deny" ? result.reason : undefined,
          });
        }
      } else {
        pending.add(id);
      }
    }

    return {
      pendingIds: pending,
      queuedIds: queued,
      approvalMap: map,
      stubDescriptions: descriptions,
      queuedDecisions: decisions,
    };
  }, [pendingApprovals, approvalResults, activeApprovalId]);

  const [activeOverlay, setActiveOverlay] = useState<ActiveOverlay>(null);
  const pendingOverlayCommandRef = useRef<{
    overlay: ActiveOverlay;
    command: CommandHandle;
    openingOutput: string;
    dismissOutput: string;
  } | null>(null);
  const memoryFilesystemInitializedRef = useRef(false);
  const memfsWatcherRef = useRef<ReturnType<
    typeof import("node:fs").watch
  > | null>(null);
  const pendingGitReminderRef = useRef<{
    dirty: boolean;
    aheadOfRemote: boolean;
    summary: string;
  } | null>(null);
  const [feedbackPrefill, setFeedbackPrefill] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [modelSelectorOptions, setModelSelectorOptions] = useState<{
    filterProvider?: string;
    forceRefresh?: boolean;
  }>({});
  const [modelReasoningPrompt, setModelReasoningPrompt] = useState<{
    modelLabel: string;
    initialModelId: string;
    initialEffort?: ModelReasoningSelection;
    options: Array<{
      effort: ModelReasoningSelection;
      modelId: string;
      selection?: ModelSelectorSelection;
    }>;
  } | null>(null);
  const closeOverlay = useCallback(() => {
    const pending = pendingOverlayCommandRef.current;
    if (pending && pending.overlay === activeOverlay) {
      pending.command.finish(pending.dismissOutput, true);
      pendingOverlayCommandRef.current = null;
    }
    setActiveOverlay(null);
    setFeedbackPrefill("");
    setSearchQuery("");
    setModelSelectorOptions({});
    setModelReasoningPrompt(null);
  }, [activeOverlay]);

  const [queuedOverlayAction, setQueuedOverlayAction] =
    useState<QueuedOverlayAction>(null);

  const anySelectorOpen = activeOverlay !== null;

  const [currentSystemPromptId, setCurrentSystemPromptId] = useState<
    string | null
  >("default");
  const [currentPersonalityId, setCurrentPersonalityId] =
    useState<PersonalityId | null>(null);
  const [currentToolset, setCurrentToolset] = useState<ToolsetName | null>(
    null,
  );
  const [currentToolsetPreference, setCurrentToolsetPreference] =
    useState<ToolsetPreference>("auto");
  const [llmConfig, setLlmConfig] = useState<LlmConfig | null>(null);
  const [
    hasConversationModelOverride,
    setHasConversationModelOverride,
    hasConversationModelOverrideRef,
  ] = useSyncedState(false);
  const llmConfigRef = useRef(llmConfig);
  useEffect(() => {
    llmConfigRef.current = llmConfig;
  }, [llmConfig]);

  const [
    conversationOverrideModelSettings,
    setConversationOverrideModelSettings,
  ] = useState<AgentState["model_settings"] | null>(null);
  const conversationOverrideModelSettingsRef = useRef(
    conversationOverrideModelSettings,
  );
  useEffect(() => {
    conversationOverrideModelSettingsRef.current =
      conversationOverrideModelSettings;
  }, [conversationOverrideModelSettings]);
  const [
    conversationOverrideContextWindowLimit,
    setConversationOverrideContextWindowLimit,
  ] = useState<number | null>(null);
  const conversationOverrideContextWindowLimitRef = useRef(
    conversationOverrideContextWindowLimit,
  );
  useEffect(() => {
    conversationOverrideContextWindowLimitRef.current =
      conversationOverrideContextWindowLimit;
  }, [conversationOverrideContextWindowLimit]);
  const agentStateRef = useRef(agentState);
  useEffect(() => {
    agentStateRef.current = agentState;
  }, [agentState]);
  const [currentModelId, setCurrentModelId] = useState<string | null>(null);
  const [tempModelOverride, _setTempModelOverride] = useState<string | null>(
    null,
  );
  const [tempModelOverrideContext, setTempModelOverrideContext] = useState<{
    agentId: string;
    conversationId: string;
  }>({ agentId, conversationId });
  const tempModelOverrideRef = useRef<string | null>(null);
  const setTempModelOverride = useCallback((next: string | null) => {
    tempModelOverrideRef.current = next;
    _setTempModelOverride(next);
  }, []);

  if (
    tempModelOverrideContext.agentId !== agentId ||
    tempModelOverrideContext.conversationId !== conversationId
  ) {
    setTempModelOverrideContext({ agentId, conversationId });
    if (tempModelOverride !== null) {
      setTempModelOverride(null);
    } else if (tempModelOverrideRef.current !== null) {
      tempModelOverrideRef.current = null;
    }
  }
  const [currentModelHandle, setCurrentModelHandle] = useState<string | null>(
    null,
  );
  const currentModelHandleRef = useRef(currentModelHandle);
  useEffect(() => {
    currentModelHandleRef.current = currentModelHandle;
  }, [currentModelHandle]);
  const agentName = agentState?.name ?? null;
  const [agentDescription, setAgentDescription] = useState<string | null>(null);
  const [agentLastRunAt, setAgentLastRunAt] = useState<string | null>(null);
  const currentModelLabel =
    tempModelOverride ||
    currentModelHandle ||
    agentState?.model ||
    (llmConfig?.model_endpoint_type && llmConfig?.model
      ? `${llmConfig.model_endpoint_type}/${llmConfig.model}`
      : (llmConfig?.model ?? null)) ||
    null;

  const effectiveModelSettings = hasConversationModelOverride
    ? conversationOverrideModelSettings
    : agentState?.model_settings;
  const derivedReasoningEffort: ModelReasoningEffort | null =
    deriveReasoningEffort(effectiveModelSettings, llmConfig);
  const currentModelServiceTier =
    (effectiveModelSettings as { service_tier?: unknown } | null | undefined)
      ?.service_tier === CHATGPT_FAST_SERVICE_TIER &&
    currentModelLabel &&
    getChatGptFastRegistryHandleForModelHandle(currentModelLabel)
      ? CHATGPT_FAST_SERVICE_TIER
      : null;
  const startupModelDisplayOverride = getStartupModelDisplayOverride({
    isLocalBackend: isLocalBackendEnabled(),
    startupHasAvailableLocalModels: hasAvailableLocalModels,
  });

  const currentModelDisplay = useMemo(() => {
    if (startupModelDisplayOverride) return startupModelDisplayOverride;
    if (!currentModelLabel) return null;
    const info = getModelInfoForLlmConfig(currentModelLabel, {
      reasoning_effort: derivedReasoningEffort ?? null,
      enable_reasoner:
        (llmConfig as { enable_reasoner?: boolean | null })?.enable_reasoner ??
        null,
      context_window: llmConfig?.context_window ?? null,
      service_tier: currentModelServiceTier,
    });
    if (info) {
      return (info as { shortLabel?: string }).shortLabel ?? info.label;
    }
    return (
      getModelShortName(currentModelLabel) ??
      currentModelLabel.split("/").pop() ??
      null
    );
  }, [
    currentModelLabel,
    derivedReasoningEffort,
    currentModelServiceTier,
    llmConfig,
    startupModelDisplayOverride,
  ]);

  const currentModelProvider = llmConfig?.provider_name ?? null;
  const isLocalBackend = isLocalBackendEnabled();
  const currentReasoningEffort: ModelReasoningEffort | null =
    currentModelLabel?.startsWith("letta/auto")
      ? null
      : (derivedReasoningEffort ??
        inferReasoningEffortFromModelPreset(currentModelId, currentModelLabel));
  const modelPresetContextWindow = useMemo(() => {
    if (!currentModelLabel) return undefined;
    const info = getModelInfoForLlmConfig(currentModelLabel, {
      reasoning_effort: derivedReasoningEffort ?? null,
      enable_reasoner:
        (llmConfig as { enable_reasoner?: boolean | null })?.enable_reasoner ??
        null,
      context_window: llmConfig?.context_window ?? null,
    });
    const rawContextWindow = (
      info?.updateArgs as { context_window?: unknown } | undefined
    )?.context_window;
    return typeof rawContextWindow === "number" ? rawContextWindow : undefined;
  }, [currentModelLabel, derivedReasoningEffort, llmConfig]);
  const effectiveContextWindowSize =
    (hasConversationModelOverride
      ? (conversationOverrideContextWindowLimit ?? modelPresetContextWindow)
      : undefined) ??
    llmConfig?.context_window ??
    modelPresetContextWindow;

  const hasTemporaryModelOverride = tempModelOverride !== null;

  const [billingTier, setBillingTier] = useState<string | null>(null);

  useEffect(() => {
    setErrorContext({
      modelDisplayName: currentModelDisplay ?? undefined,
      billingTier: billingTier ?? undefined,
      modelEndpointType: llmConfig?.model_endpoint_type ?? undefined,
      modelLabel: currentModelLabel ?? undefined,
    });
  }, [
    currentModelDisplay,
    billingTier,
    llmConfig?.model_endpoint_type,
    currentModelLabel,
  ]);

  useEffect(() => {
    (async () => {
      try {
        const tier = await getBillingTier();
        if (tier) {
          setBillingTier(tier);
        }
      } catch {}
    })();
  }, []);

  const [tokenStreamingEnabled, setTokenStreamingEnabled] =
    useState(tokenStreaming);

  const [reasoningTabCycleEnabled, _setReasoningTabCycleEnabled] = useState(
    initialReasoningTabCycleEnabled,
  );

  const [showCompactionsEnabled, _setShowCompactionsEnabled] =
    useState(showCompactions);
  const [terminalTitleConfigRefreshEpoch, setTerminalTitleConfigRefreshEpoch] =
    useState(0);

  const [tokenCount, setTokenCount] = useState(0);

  const [usedContextTokens, setUsedContextTokens] = useState(0);

  const [trajectoryTokenBase, setTrajectoryTokenBase] = useState(0);
  const [trajectoryElapsedBaseMs, setTrajectoryElapsedBaseMs] = useState(0);
  const trajectoryRunTokenStartRef = useRef(0);
  const trajectoryTokenDisplayRef = useRef(0);
  const trajectorySegmentStartRef = useRef<number | null>(null);

  const [thinkingMessage, setThinkingMessage] = useState(
    getRandomThinkingVerb(),
  );
  const [terminalTitlePreviewOverride, setTerminalTitlePreviewOverride] =
    useState<string | null | undefined>(undefined);
  const clearTerminalTitlePreviewOverride = useCallback(() => {
    setTerminalTitlePreviewOverride(undefined);
  }, []);

  const sessionStatsRef = useRef(new SessionStats());
  const sessionStartTimeRef = useRef(Date.now());
  const sessionHooksRanRef = useRef(false);
  const sessionModStartAttemptedRef = useRef(false);
  const modAdapterRef = useRef<LocalModAdapter | null>(null);

  useEffect(() => {
    if (agentId && agentId !== "loading") {
      chunkLog.init(agentId, telemetry.getSessionId());
      debugLogFile.init(agentId, telemetry.getSessionId());
    }
  }, [agentId]);

  const syncTrajectoryTokenBase = useCallback(() => {
    const snapshot = sessionStatsRef.current.getTrajectorySnapshot();
    setTrajectoryTokenBase(snapshot?.tokens ?? 0);
  }, []);

  const openTrajectorySegment = useCallback(() => {
    if (trajectorySegmentStartRef.current === null) {
      trajectorySegmentStartRef.current = performance.now();
      sessionStatsRef.current.startTrajectory();
    }
  }, []);

  const closeTrajectorySegment = useCallback(() => {
    const start = trajectorySegmentStartRef.current;
    if (start !== null) {
      const segmentMs = performance.now() - start;
      sessionStatsRef.current.accumulateTrajectory({ wallMs: segmentMs });
      trajectorySegmentStartRef.current = null;
    }
  }, []);

  const syncTrajectoryElapsedBase = useCallback(() => {
    const snapshot = sessionStatsRef.current.getTrajectorySnapshot();
    setTrajectoryElapsedBaseMs(snapshot?.wallMs ?? 0);
  }, []);

  const resetTrajectoryBases = useCallback(() => {
    sessionStatsRef.current.resetTrajectory();
    setTrajectoryTokenBase(0);
    setTrajectoryElapsedBaseMs(0);
    trajectoryRunTokenStartRef.current = 0;
    trajectoryTokenDisplayRef.current = 0;
    trajectorySegmentStartRef.current = null;
  }, []);

  useEffect(() => {
    telemetry.setSessionStatsGetter(() =>
      sessionStatsRef.current.getSnapshot(),
    );

    return () => {
      telemetry.setSessionStatsGetter(undefined);
    };
  }, []);

  useEffect(() => {
    if (streaming) {
      openTrajectorySegment();
      return;
    }
    closeTrajectorySegment();
    syncTrajectoryElapsedBase();
  }, [
    streaming,
    openTrajectorySegment,
    closeTrajectorySegment,
    syncTrajectoryElapsedBase,
  ]);

  const sessionStartFeedbackRef = useRef<string[]>([]);

  useEffect(() => {
    if (agentId && agentId !== "loading" && !sessionHooksRanRef.current) {
      sessionHooksRanRef.current = true;
      const isNewSession = !initialConversationId;
      runSessionStartHooks(
        isNewSession,
        agentId,
        agentName ?? undefined,
        conversationIdRef.current ?? undefined,
      )
        .then((result) => {
          if (result.feedback.length > 0) {
            sessionStartFeedbackRef.current = result.feedback;
          }
        })
        .catch(() => {});
    }
  }, [agentId, agentName, initialConversationId]);

  const runEndHooks = useCallback(
    async (reason: ModConversationCloseReason = "quit") => {
      const durationMs = Date.now() - sessionStartTimeRef.current;
      try {
        await runSessionEndHooks(
          durationMs,
          undefined,
          undefined,
          agentIdRef.current ?? undefined,
          conversationIdRef.current ?? undefined,
        );
      } catch {}

      const modAdapter = modAdapterRef.current;
      if (modAdapter) {
        try {
          await modAdapter.events.emit(
            "conversation_close",
            {
              agentId: agentIdRef.current ?? null,
              conversationId: conversationIdRef.current ?? null,
              durationMs,
              messageCount: telemetry.getMessageCount(),
              reason,
              toolCallCount: telemetry.getToolCallCount(),
            },
            modAdapter.context,
          );
        } catch {}
      }
    },
    [],
  );

  const [showExitStats, setShowExitStats] = useState(false);

  const sharedReminderStateRef = useRef<SharedReminderState>(
    (() => {
      const state = createSharedReminderState();
      state.pendingConversationBootstrap = !resumedExistingConversation;
      return state;
    })(),
  );
  const _systemPromptRecompileByConversationRef = useRef(
    new Map<string, Promise<void>>(),
  );
  const _queuedSystemPromptRecompileByConversationRef = useRef(
    new Set<string>(),
  );

  const shouldAutoGenerateConversationTitleRef = useRef(
    !resumedExistingConversation || startupConversationTitleEligible,
  );
  const isAutoConversationTitleInFlightRef = useRef(false);
  const shouldAutoGenerateConversationDescriptionRef = useRef(
    !resumedExistingConversation,
  );
  const isAutoConversationDescriptionInFlightRef = useRef(false);
  const firstUserQueryRef = useRef<string | null>(null);
  const setConversationAutoTitleEligibility = useCallback(
    (enabled: boolean) => {
      shouldAutoGenerateConversationTitleRef.current = enabled;
      isAutoConversationTitleInFlightRef.current = false;
      shouldAutoGenerateConversationDescriptionRef.current = enabled;
      isAutoConversationDescriptionInFlightRef.current = false;
      firstUserQueryRef.current = null;
    },
    [],
  );
  useConversationTitleSync(conversationId, setConversationSummary);
  const deriveAutoConversationTitle = useCallback(() => {
    if (firstUserQueryRef.current) {
      return firstUserQueryRef.current;
    }

    for (const lineId of buffersRef.current.order) {
      const line = buffersRef.current.byId.get(lineId);
      if (!line || line.kind !== "user") {
        continue;
      }

      const title = normalizeConversationTitle(line.text);
      if (title) {
        return title;
      }
    }

    return null;
  }, []);
  const generateConversationTitle = useCallback(async () => {
    const fallback = deriveAutoConversationTitle();

    if (!getConversationTitleSettings().enabled) {
      return fallback;
    }
    if (getBackend().capabilities.localModelCatalog) {
      return fallback;
    }
    const conversationId = conversationIdRef.current;
    if (!conversationId || conversationId === "default") {
      return fallback;
    }

    try {
      const messages = await listConversationTitleMessages(
        getBackend(),
        conversationId,
      );

      let summaryModel: string | undefined;
      if (currentModelLabel) {
        try {
          const providers = await listProviders();
          const byokProviderAliases = buildByokProviderAliases(providers);
          summaryModel = isByokHandleForSelector(
            currentModelLabel,
            byokProviderAliases,
          )
            ? currentModelLabel
            : undefined;
        } catch {
          const byokProviderAliases = buildByokProviderAliases([]);
          summaryModel = isByokHandleForSelector(
            currentModelLabel,
            byokProviderAliases,
          )
            ? currentModelLabel
            : undefined;
        }
      }
      const aiTitle = await generateConversationTitleFromSummary(
        conversationId,
        messages,
        summaryModel,
      );
      return aiTitle ?? fallback;
    } catch (err) {
      if (isDebugEnabled()) {
        console.error("[DEBUG] generateConversationTitle failed:", err);
      }
      return fallback;
    }
  }, [deriveAutoConversationTitle, currentModelLabel]);
  const generateConversationDescription = useCallback(
    async (options?: { force?: boolean }) => {
      if (!experimentManager.isEnabled("desktop_conversation_bootstrap")) {
        return;
      }
      if (
        (!options?.force &&
          !shouldAutoGenerateConversationDescriptionRef.current) ||
        isAutoConversationDescriptionInFlightRef.current
      ) {
        return;
      }
      if (getBackend().capabilities.localModelCatalog) {
        return;
      }

      const conversationId = conversationIdRef.current;
      if (!conversationId || conversationId === "default") {
        return;
      }

      isAutoConversationDescriptionInFlightRef.current = true;
      try {
        const updated = await regenerateConversationDescription(conversationId);
        if (updated) {
          shouldAutoGenerateConversationDescriptionRef.current = false;
        }
      } catch (err) {
        if (isDebugEnabled()) {
          console.error("[DEBUG] generateConversationDescription failed:", err);
        }
      } finally {
        isAutoConversationDescriptionInFlightRef.current = false;
      }
    },
    [],
  );
  const resetBootstrapReminderState = useCallback(
    (pendingConversationBootstrap = false) => {
      resetSharedReminderState(sharedReminderStateRef.current);
      sharedReminderStateRef.current.pendingConversationBootstrap =
        pendingConversationBootstrap;
    },
    [],
  );
  const [staticItems, setStaticItems] = useState<StaticItem[]>([]);

  const [footerUpdateText, setFooterUpdateText] = useState<string | null>(null);
  useEffect(() => {
    if (!updateNotification) return;
    setStaticItems((prev) => {
      if (prev.some((item) => item.id === "update-notification")) return prev;
      return [
        ...prev,
        {
          kind: "status" as const,
          id: "update-notification",
          lines: [
            `A new version of Letta Code is available (**${updateNotification}**). Restart to update!`,
          ],
        },
      ];
    });
    setFooterUpdateText(
      `New version available (${updateNotification}). Restart to update!`,
    );
    const timer = setTimeout(() => setFooterUpdateText(null), 8000);
    return () => clearTimeout(timer);
  }, [updateNotification]);

  const emittedIdsRef = useRef<Set<string>>(new Set());

  const welcomeCommittedRef = useRef(false);

  const abortControllerRef = useRef<AbortController | null>(null);

  const userCancelledRef = useRef(false);

  const llmApiErrorRetriesRef = useRef(0);
  const emptyResponseRetriesRef = useRef(0);
  const chatgptPlanSwapsRef = useRef(0);
  const chatgptExhaustedProvidersRef = useRef(new Set<string>());
  const conversationBusyRetriesRef = useRef(0);

  const [queueDisplay, setQueueDisplay] = useState<QueuedMessage[]>([]);

  const tuiQueueRef = useRef<QueueRuntime | null>(null);
  if (!tuiQueueRef.current) {
    tuiQueueRef.current = createTuiQueueRuntime(setQueueDisplay);
  }

  const overrideContentPartsRef = useRef<MessageCreate["content"] | null>(null);

  useEffect(() => {
    setMessageQueueAdder((message: QueuedMessage) => {
      tuiQueueRef.current?.enqueue(
        message.kind === "task_notification"
          ? ({
              kind: "task_notification",
              source: "task_notification",
              text: message.text,
              content: message.content,
            } as Parameters<typeof tuiQueueRef.current.enqueue>[0])
          : ({
              kind: "message",
              source: message.source ?? "user",
              content: message.text,
            } as Parameters<typeof tuiQueueRef.current.enqueue>[0]),
      );
      setDequeueEpoch((e) => e + 1);
    });
    return () => setMessageQueueAdder(null);
  }, []);
  useEffect(() => {
    if (!agentId || agentId === "loading") return;

    const TICK_INTERVAL_MS = 60_000;
    const firedThisMinute = new Set<string>();
    let lastMinuteKey = "";

    function tick(): void {
      if (!experimentManager.isEnabled("tui_cron")) return;

      const now = new Date();
      const currentMinuteKey = (() => {
        const d = now;
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
      })();

      if (currentMinuteKey !== lastMinuteKey) {
        firedThisMinute.clear();
        lastMinuteKey = currentMinuteKey;
      }

      const cronData = readCronFile();
      if (
        hasLiveSchedulerOwner(
          cronData,
          isLocalAgentId(agentIdRef.current ?? "") ? "local" : "cloud",
        )
      ) {
        return;
      }

      const activeTasks = cronData.tasks.filter(
        (t) => t.status === "active" && t.agent_id === agentIdRef.current,
      );

      for (const task of activeTasks) {
        if (firedThisMinute.has(task.id)) continue;

        if (handleTaskPreflight(task, now)) continue;

        if (shouldFireTask(task, now)) {
          firedThisMinute.add(task.id);
          const intendedOccurrence = getIntendedCronOccurrence(task, now);

          const jitterMs = task.recurring ? task.jitter_offset_ms : 0;
          const taskId = task.id;
          const doFire = () => {
            const freshTask = getTask(taskId);
            if (!freshTask || freshTask.status !== "active") return;

            const schedulerNow = new Date();
            const text = wrapCronPrompt(freshTask, {
              intendedOccurrence,
              schedulerNow,
            });
            addToMessageQueue({
              kind: "user",
              source: "cron",
              text,
              agentId: freshTask.agent_id,
              conversationId: freshTask.conversation_id,
            });

            const nowIso = schedulerNow.toISOString();
            if (freshTask.recurring) {
              updateTask(freshTask.id, (t) => {
                t.last_fired_at = nowIso;
                t.fire_count += 1;
              });
            } else {
              updateTask(freshTask.id, (t) => {
                t.status = "fired";
                t.fired_at = nowIso;
                t.last_fired_at = nowIso;
                t.fire_count = 1;
              });
            }

            safeAppendCronRunLogForTask(freshTask, {
              status: "ok",
              runAtMs: schedulerNow.getTime(),
              scheduledFor: freshTask.scheduled_for,
              firedAt: nowIso,
            });

            debugLog("cron", `TUI shadow scheduler fired task ${taskId}`);
          };

          if (jitterMs > 0) {
            setTimeout(doFire, jitterMs);
          } else {
            doFire();
          }
        }
      }
    }

    tick();

    const interval = setInterval(tick, TICK_INTERVAL_MS);
    debugLog("cron", "TUI shadow scheduler started");

    return () => {
      clearInterval(interval);
      debugLog("cron", "TUI shadow scheduler stopped");
    };
  }, [agentId]);

  const waitingForQueueCancelRef = useRef(false);
  const queueSnapshotRef = useRef<QueuedMessage[]>([]);
  const [restoreQueueOnCancel, setRestoreQueueOnCancel] = useState(false);
  const restoreQueueOnCancelRef = useRef(restoreQueueOnCancel);
  useEffect(() => {
    restoreQueueOnCancelRef.current = restoreQueueOnCancel;
  }, [restoreQueueOnCancel]);

  const lastSentInputRef = useRef<Array<MessageCreate | ApprovalCreate> | null>(
    null,
  );
  const approvalToolContextIdRef = useRef<string | null>(null);
  const clearApprovalToolContext = useCallback(() => {
    const contextId = approvalToolContextIdRef.current;
    if (!contextId) return;
    approvalToolContextIdRef.current = null;
    releaseToolExecutionContext(contextId);
  }, []);
  const prepareScopedToolExecutionContext = useCallback(
    async (overrideModel?: string | null) => {
      const workingDirectory = getCurrentWorkingDirectory();
      const desiredModel = overrideModel ?? currentModelHandle;

      if (agentIdRef.current) {
        return prepareToolExecutionContextForScope({
          agentId: agentIdRef.current,
          conversationId: conversationIdRef.current,
          overrideModel: desiredModel,
          workingDirectory,
          modContext: modAdapterRef.current?.context,
          modEvents: modAdapterRef.current?.events,
        });
      }

      if (desiredModel) {
        return prepareToolExecutionContextForResolvedTarget({
          modelIdentifier: desiredModel,
          conversationId: conversationIdRef.current,
          modContext: modAdapterRef.current?.context,
          modEvents: modAdapterRef.current?.events,
          toolsetPreference: currentToolsetPreference,
          workingDirectory,
        });
      }

      return prepareToolExecutionContextForResolvedTarget({
        modelIdentifier: null,
        conversationId: conversationIdRef.current,
        modContext: modAdapterRef.current?.context,
        modEvents: modAdapterRef.current?.events,
        toolsetPreference: currentToolsetPreference,
        workingDirectory,
      });
    },
    [currentModelHandle, currentToolsetPreference],
  );
  const pendingInterruptRecoveryConversationIdRef = useRef<string | null>(null);

  const [dequeueEpoch, setDequeueEpoch] = useState(0);
  const dequeueInFlightRef = useRef(false);

  const deferModeSupported = !isLocalAgentId(agentId);
  const [queueMode, setQueueMode] = useState<"immediate" | "defer">(
    "immediate",
  );
  const handleCtrlD = useCallback(() => {
    if (!deferModeSupported) return;
    setQueueMode((prev) => (prev === "immediate" ? "defer" : "immediate"));
  }, [deferModeSupported]);
  const queueModeRef = useRef<"immediate" | "defer">("immediate");
  queueModeRef.current = queueMode;
  const lastStopReasonRef = useRef<string | null>(null);

  const lastDequeuedMessageRef = useRef<string | null>(null);

  const [restoredInput, setRestoredInput] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refs are stable objects, .current is read dynamically
  const isAgentBusy = useCallback(() => {
    return (
      streamingRef.current ||
      isExecutingTool ||
      commandRunningRef.current ||
      abortControllerRef.current !== null
    );
  }, [isExecutingTool]);

  const refreshDerivedRef = useRef<(() => void) | null>(null);

  const appendTaskNotificationEvents = useCallback(
    (summaries: string[]): boolean =>
      appendTaskNotificationEventsToBuffer(
        summaries,
        buffersRef.current,
        () => uid("event"),
        () => refreshDerivedRef.current?.(),
      ),
    [],
  );
  const appendModNotification = useCallback(
    (message: string) => appendTaskNotificationEvents([message]),
    [appendTaskNotificationEvents],
  );

  const consumeQueuedMessages = useCallback((): QueuedMessage[] | null => {
    const len = tuiQueueRef.current?.length ?? 0;
    if (len === 0) return null;
    const batch = tuiQueueRef.current?.consumeItems(len);
    if (!batch) return null;
    return batch.items
      .filter(
        (item): item is MessageQueueItem | TaskNotificationQueueItem =>
          item.kind === "message" || item.kind === "task_notification",
      )
      .map(toTuiQueuedMessage);
  }, []);

  const withCommandLock = useCallback(
    async (asyncFn: () => Promise<void>) => {
      setActiveOverlay(null);
      setCommandRunning(true);
      try {
        await asyncFn();
      } finally {
        setCommandRunning(false);
      }
    },
    [setCommandRunning],
  );

  const rawColumns = useTerminalWidth();
  const terminalRows = useTerminalRows();
  const [stableColumns, setStableColumns] = useState(rawColumns);
  const stableColumnsTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const prevColumnsRef = useRef(rawColumns);
  const lastResizeColumnsRef = useRef(rawColumns);
  const lastResizeRowsRef = useRef(terminalRows);
  const lastClearedColumnsRef = useRef(rawColumns);
  const pendingResizeRef = useRef(false);
  const pendingResizeColumnsRef = useRef<number | null>(null);
  const [staticRenderEpoch, setStaticRenderEpoch] = useState(0);
  const resizeClearTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastClearAtRef = useRef(0);
  const resizeGestureTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const didImmediateShrinkClearRef = useRef(false);
  const isInitialResizeRef = useRef(true);
  const columns = stableColumns;
  const chromeColumns = Math.min(rawColumns, stableColumns);
  const debugFlicker = process.env.LETTA_DEBUG_FLICKER === "1";

  useEffect(() => {
    if (
      typeof process === "undefined" ||
      !process.stdout ||
      !("on" in process.stdout) ||
      !process.stdout.isTTY
    ) {
      return;
    }

    const stdout = process.stdout;
    const onResize = () => {
      const nextColumns = stdout.columns ?? lastResizeColumnsRef.current;
      const nextRows = stdout.rows ?? lastResizeRowsRef.current;

      const prevColumns = lastResizeColumnsRef.current;
      const prevRows = lastResizeRowsRef.current;

      lastResizeColumnsRef.current = nextColumns;
      lastResizeRowsRef.current = nextRows;

      if (isInitialResizeRef.current) {
        return;
      }

      const shrunk = nextColumns < prevColumns || nextRows < prevRows;
      if (!shrunk) {
        if (resizeGestureTimeoutRef.current) {
          clearTimeout(resizeGestureTimeoutRef.current);
        }
        resizeGestureTimeoutRef.current = setTimeout(() => {
          resizeGestureTimeoutRef.current = null;
          didImmediateShrinkClearRef.current = false;
        }, RESIZE_SETTLE_MS);
        return;
      }

      if (didImmediateShrinkClearRef.current) {
        if (resizeGestureTimeoutRef.current) {
          clearTimeout(resizeGestureTimeoutRef.current);
        }
        resizeGestureTimeoutRef.current = setTimeout(() => {
          resizeGestureTimeoutRef.current = null;
          didImmediateShrinkClearRef.current = false;
        }, RESIZE_SETTLE_MS);
        return;
      }

      if (debugFlicker) {
        // eslint-disable-next-line no-console
        console.error(
          `[debug:flicker:resize-immediate-clear] next=${nextColumns}x${nextRows} prev=${prevColumns}x${prevRows} streaming=${streamingRef.current}`,
        );
      }

      if (resizeClearTimeout.current) {
        clearTimeout(resizeClearTimeout.current);
        resizeClearTimeout.current = null;
      }

      stdout.write(CLEAR_SCREEN_AND_HOME);
      setStaticRenderEpoch((epoch) => epoch + 1);
      lastClearedColumnsRef.current = nextColumns;
      lastClearAtRef.current = Date.now();
      didImmediateShrinkClearRef.current = true;
      if (resizeGestureTimeoutRef.current) {
        clearTimeout(resizeGestureTimeoutRef.current);
      }
      resizeGestureTimeoutRef.current = setTimeout(() => {
        resizeGestureTimeoutRef.current = null;
        didImmediateShrinkClearRef.current = false;
      }, RESIZE_SETTLE_MS);
    };

    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
      if (resizeGestureTimeoutRef.current) {
        clearTimeout(resizeGestureTimeoutRef.current);
        resizeGestureTimeoutRef.current = null;
      }
    };
  }, [debugFlicker, streamingRef]);

  useEffect(() => {
    if (rawColumns === stableColumns) {
      if (stableColumnsTimeoutRef.current) {
        clearTimeout(stableColumnsTimeoutRef.current);
        stableColumnsTimeoutRef.current = null;
      }
      return;
    }

    const delta = Math.abs(rawColumns - stableColumns);
    if (delta >= MIN_RESIZE_DELTA) {
      if (stableColumnsTimeoutRef.current) {
        clearTimeout(stableColumnsTimeoutRef.current);
        stableColumnsTimeoutRef.current = null;
      }
      setStableColumns(rawColumns);
      return;
    }

    if (stableColumnsTimeoutRef.current) {
      clearTimeout(stableColumnsTimeoutRef.current);
    }
    stableColumnsTimeoutRef.current = setTimeout(() => {
      stableColumnsTimeoutRef.current = null;
      setStableColumns(rawColumns);
    }, STABLE_WIDTH_SETTLE_MS);
  }, [rawColumns, stableColumns]);

  const clearAndRemount = useCallback(
    (targetColumns: number) => {
      if (debugFlicker) {
        // eslint-disable-next-line no-console
        console.error(
          `[debug:flicker:clear-remount] target=${targetColumns} previousCleared=${lastClearedColumnsRef.current} raw=${prevColumnsRef.current}`,
        );
      }

      if (
        typeof process !== "undefined" &&
        process.stdout &&
        "write" in process.stdout &&
        process.stdout.isTTY
      ) {
        process.stdout.write(CLEAR_SCREEN_AND_HOME);
      }
      setStaticRenderEpoch((epoch) => epoch + 1);
      lastClearedColumnsRef.current = targetColumns;
      lastClearAtRef.current = Date.now();
    },
    [debugFlicker],
  );

  const scheduleResizeClear = useCallback(
    (targetColumns: number) => {
      if (targetColumns === lastClearedColumnsRef.current) {
        return;
      }

      if (resizeClearTimeout.current) {
        clearTimeout(resizeClearTimeout.current);
        resizeClearTimeout.current = null;
      }

      const elapsedSinceClear = Date.now() - lastClearAtRef.current;
      const rateLimitDelay =
        elapsedSinceClear >= MIN_CLEAR_INTERVAL_MS
          ? 0
          : MIN_CLEAR_INTERVAL_MS - elapsedSinceClear;
      const delay = Math.max(RESIZE_SETTLE_MS, rateLimitDelay);
      if (debugFlicker) {
        // eslint-disable-next-line no-console
        console.error(
          `[debug:flicker:resize-schedule] target=${targetColumns} delay=${delay}ms elapsedSinceClear=${elapsedSinceClear}ms`,
        );
      }

      resizeClearTimeout.current = setTimeout(() => {
        resizeClearTimeout.current = null;

        if (prevColumnsRef.current !== targetColumns) {
          if (debugFlicker) {
            // eslint-disable-next-line no-console
            console.error(
              `[debug:flicker:resize-skip] stale target=${targetColumns} currentRaw=${prevColumnsRef.current}`,
            );
          }
          return;
        }

        if (targetColumns === lastClearedColumnsRef.current) {
          if (debugFlicker) {
            // eslint-disable-next-line no-console
            console.error(
              `[debug:flicker:resize-skip] already-cleared target=${targetColumns}`,
            );
          }
          return;
        }

        if (debugFlicker) {
          // eslint-disable-next-line no-console
          console.error(
            `[debug:flicker:resize-fire] clear target=${targetColumns}`,
          );
        }
        clearAndRemount(targetColumns);
      }, delay);
    },
    [clearAndRemount, debugFlicker],
  );

  useEffect(() => {
    const prev = prevColumnsRef.current;
    if (rawColumns === prev) return;

    if (resizeClearTimeout.current) {
      clearTimeout(resizeClearTimeout.current);
      resizeClearTimeout.current = null;
    }

    if (isInitialResizeRef.current) {
      isInitialResizeRef.current = false;
      prevColumnsRef.current = rawColumns;
      lastClearedColumnsRef.current = rawColumns;
      return;
    }

    const delta = Math.abs(rawColumns - prev);
    const isMinorJitter = delta > 0 && delta < MIN_RESIZE_DELTA;
    if (isMinorJitter) {
      prevColumnsRef.current = rawColumns;
      return;
    }

    if (streaming) {
      pendingResizeRef.current = true;
      pendingResizeColumnsRef.current = rawColumns;
      prevColumnsRef.current = rawColumns;
      return;
    }

    if (rawColumns === lastClearedColumnsRef.current) {
      pendingResizeRef.current = false;
      pendingResizeColumnsRef.current = null;
      prevColumnsRef.current = rawColumns;
      return;
    }

    scheduleResizeClear(rawColumns);

    prevColumnsRef.current = rawColumns;
  }, [rawColumns, streaming, scheduleResizeClear]);

  useEffect(() => {
    if (isInitialResizeRef.current) return;
    if (streaming) return;
    if (stableColumns === lastClearedColumnsRef.current) return;
    scheduleResizeClear(stableColumns);
  }, [stableColumns, streaming, scheduleResizeClear]);

  useEffect(() => {
    if (streaming) {
      if (resizeClearTimeout.current) {
        clearTimeout(resizeClearTimeout.current);
        resizeClearTimeout.current = null;
        pendingResizeRef.current = true;
        pendingResizeColumnsRef.current = rawColumns;
      }
      return;
    }

    if (!pendingResizeRef.current) return;

    const pendingColumns = pendingResizeColumnsRef.current;
    pendingResizeRef.current = false;
    pendingResizeColumnsRef.current = null;

    if (pendingColumns === null) return;
    if (pendingColumns === lastClearedColumnsRef.current) return;

    scheduleResizeClear(pendingColumns);
  }, [rawColumns, streaming, scheduleResizeClear]);

  useEffect(() => {
    return () => {
      if (resizeClearTimeout.current) {
        clearTimeout(resizeClearTimeout.current);
        resizeClearTimeout.current = null;
      }
      if (stableColumnsTimeoutRef.current) {
        clearTimeout(stableColumnsTimeoutRef.current);
        stableColumnsTimeoutRef.current = null;
      }
    };
  }, []);

  const deferredToolCallCommitsRef = useRef<Map<string, number>>(new Map());
  const [deferredCommitAt, setDeferredCommitAt] = useState<number | null>(null);
  const resetDeferredToolCallCommits = useCallback(() => {
    deferredToolCallCommitsRef.current.clear();
    setDeferredCommitAt(null);
  }, []);

  const commitEligibleLines = useCallback(
    (b: Buffers, opts?: { deferToolCalls?: boolean }) => {
      const deferToolCalls = opts?.deferToolCalls !== false;
      const newlyCommitted: StaticItem[] = [];
      let firstTaskIndex = -1;
      const deferredCommits = deferredToolCallCommitsRef.current;
      const now = Date.now();
      let blockedByDeferred = false;
      const shouldSkipCommittedToolCall = (ln: Line): boolean => {
        if (ln.kind !== "tool_call") return false;
        if (!ln.toolCallId || !ln.name) return false;
        if (ln.phase !== "finished" || ln.resultOk === false) return false;
        if (!eagerCommittedPreviewsRef.current.has(ln.toolCallId)) return false;
        return (
          isFileEditTool(ln.name) ||
          isFileWriteTool(ln.name) ||
          isPatchTool(ln.name)
        );
      };

      const shouldSkipDeferral = (ln: Line): boolean => {
        if (ln.kind !== "tool_call") return false;
        if (ln.phase !== "finished") return false;
        return ln.resultText != null;
      };
      if (!deferToolCalls && deferredCommits.size > 0) {
        deferredCommits.clear();
        setDeferredCommitAt(null);
      }

      const hasInProgress = hasInProgressTaskToolCalls(
        b.order,
        b.byId,
        emittedIdsRef.current,
      );

      const finishedTaskToolCalls = collectFinishedTaskToolCalls(
        b.order,
        b.byId,
        emittedIdsRef.current,
        hasInProgress,
      );

      for (const id of b.order) {
        if (emittedIdsRef.current.has(id)) continue;
        const ln = b.byId.get(id);
        if (!ln) continue;
        if (
          ln.kind === "user" ||
          ln.kind === "error" ||
          ln.kind === "status" ||
          ln.kind === "trajectory_summary"
        ) {
          emittedIdsRef.current.add(id);
          newlyCommitted.push({ ...ln });
          continue;
        }
        if (ln.kind === "event" && ln.phase === "finished") {
          emittedIdsRef.current.add(id);
          newlyCommitted.push({ ...ln });
          continue;
        }
        if (ln.kind === "command" || ln.kind === "bash_command") {
          if (!ln.phase || ln.phase === "finished") {
            emittedIdsRef.current.add(id);
            newlyCommitted.push({ ...ln });
          }
          continue;
        }
        if (ln.kind === "tool_call" && ln.name && isTaskTool(ln.name)) {
          if (hasInProgress && ln.toolCallId) {
            const subagent = getSubagentByToolCallId(ln.toolCallId);
            if (subagent) {
              if (firstTaskIndex === -1) {
                firstTaskIndex = newlyCommitted.length;
              }
              continue;
            }
          }
          const hasSubagentData = finishedTaskToolCalls.some(
            (tc) => tc.lineId === id,
          );
          if (hasSubagentData) {
            if (firstTaskIndex === -1) {
              firstTaskIndex = newlyCommitted.length;
            }
            continue;
          }
          if (ln.phase === "finished") {
            emittedIdsRef.current.add(id);
            newlyCommitted.push({ ...ln });
          }
          continue;
        }
        if ("phase" in ln && ln.phase === "finished") {
          if (shouldSkipCommittedToolCall(ln)) {
            deferredCommits.delete(id);
            emittedIdsRef.current.add(id);
            continue;
          }
          if (
            deferToolCalls &&
            ln.kind === "tool_call" &&
            (!ln.name || !isTaskTool(ln.name)) &&
            !shouldSkipDeferral(ln)
          ) {
            const commitAt = deferredCommits.get(id);
            if (commitAt === undefined) {
              const nextCommitAt = now + TOOL_CALL_COMMIT_DEFER_MS;
              deferredCommits.set(id, nextCommitAt);
              setDeferredCommitAt(nextCommitAt);
              blockedByDeferred = true;
              break;
            }
            if (commitAt > now) {
              setDeferredCommitAt(commitAt);
              blockedByDeferred = true;
              break;
            }
            deferredCommits.delete(id);
          }
          emittedIdsRef.current.add(id);
          newlyCommitted.push({ ...ln });
        }
      }

      if (!blockedByDeferred && finishedTaskToolCalls.length > 0) {
        for (const tc of finishedTaskToolCalls) {
          emittedIdsRef.current.add(tc.lineId);
        }

        const groupItem = createSubagentGroupItem(finishedTaskToolCalls);

        newlyCommitted.splice(
          firstTaskIndex >= 0 ? firstTaskIndex : newlyCommitted.length,
          0,
          groupItem,
        );

        clearSubagentsByIds(groupItem.agents.map((a) => a.id));
      }

      if (deferredCommits.size === 0) {
        setDeferredCommitAt(null);
      }

      if (newlyCommitted.length > 0) {
        setStaticItems((prev) => [...prev, ...newlyCommitted]);
      }
    },
    [],
  );

  const [lines, setLines] = useState<Line[]>([]);

  const buffersRef = useRef(createBuffers());

  const contextTrackerRef = useRef(createContextTracker());

  const hasBackfilledRef = useRef(false);

  useEffect(() => {
    buffersRef.current.tokenStreamingEnabled = tokenStreamingEnabled;
  }, [tokenStreamingEnabled]);

  const sessionStatsSnapshot = sessionStatsRef.current.getSnapshot();
  const reflectionSettings = getReflectionSettings(agentId);
  const modContext = buildCliModContext({
    modelId: llmConfigRef.current?.model ?? null,
    modelDisplayName: currentModelDisplay,
    modelProvider: currentModelProvider ?? null,
    reasoningEffort: currentReasoningEffort,
    systemPromptId: currentSystemPromptId,
    toolset: currentToolset,
    currentDirectory: process.cwd(),
    projectDirectory,
    sessionId: conversationId,
    conversationSummary,
    agentId,
    agentName,
    lastRunId: lastRunIdRef.current,
    totalDurationMs: sessionStatsSnapshot.totalWallMs,
    totalApiDurationMs: sessionStatsSnapshot.totalApiMs,
    totalInputTokens: sessionStatsSnapshot.usage.promptTokens,
    totalOutputTokens: sessionStatsSnapshot.usage.completionTokens,
    contextWindowSize: effectiveContextWindowSize,
    usedContextTokens: contextTrackerRef.current.lastContextTokens,
    reflectionMode: reflectionSettings.trigger,
    reflectionStepCount: reflectionSettings.stepCount,
    memfsEnabled:
      agentId !== "loading" ? settingsManager.isMemfsEnabled(agentId) : false,
    memfsDirectory:
      agentId !== "loading" && settingsManager.isMemfsEnabled(agentId)
        ? getScopedMemoryFilesystemRoot(agentId)
        : null,
    permissionMode: uiPermissionMode,
    networkPhase,
    terminalWidth: chromeColumns,
    backgroundAgents: getActiveBackgroundAgents().map((a) => ({
      type: a.type,
      status: a.status,
      durationMs: Date.now() - a.startTime,
      agentId: a.agentId ?? null,
    })),
  });
  const agentModsDirectory =
    modContext.memfs.enabled && modContext.memfs.memoryDir
      ? join(modContext.memfs.memoryDir, "mods")
      : null;
  const modAdapter = useLocalModAdapter(modContext, {
    agentModsDirectory,
    disabled: modsDisabled,
    onNotification: appendModNotification,
  });

  useEffect(() => {
    modAdapterRef.current = modAdapter;
  }, [modAdapter]);

  useEffect(() => {
    return installLocalBackendModEventHooks({
      backend: getBackend(),
      adapter: modAdapter,
      buildContext: () => modAdapter.context,
    });
  }, [modAdapter]);

  useEffect(() => {
    if (!agentId || agentId === "loading") return;
    if (sessionModStartAttemptedRef.current) return;
    if (modAdapter.isLoading) return;
    if (!modAdapter.hasModSources) return;

    sessionModStartAttemptedRef.current = true;
    void modAdapter.events.emit(
      "conversation_open",
      {
        agentId,
        agentName: agentName ?? null,
        conversationId: conversationIdRef.current ?? null,
        reason: "startup",
      },
      modAdapter.context,
    );
  }, [agentId, agentName, modAdapter]);

  useEffect(() => {
    buffersRef.current.agentId = agentState?.id;
  }, [agentState?.id]);
  useMcpCleanup(agentState?.id);
  const precomputedDiffsRef = useRef<Map<string, AdvancedDiffSuccess>>(
    new Map(),
  );

  const eagerCommittedPreviewsRef = useRef<Set<string>>(new Set());

  const estimateApprovalPreviewLines = useCallback(
    (approval: ApprovalRequest): number => {
      const toolName = approval.toolName;
      if (!toolName) return 0;
      const args = safeJsonParseOr<Record<string, unknown>>(
        approval.toolArgs || "{}",
        {},
      );
      const wrapWidth = Math.max(MIN_WRAP_WIDTH, columns - TEXT_WRAP_GUTTER);
      const diffWrapWidth = Math.max(
        MIN_WRAP_WIDTH,
        columns - DIFF_WRAP_GUTTER,
      );

      if (isShellTool(toolName)) {
        const t = toolName.toLowerCase();
        let command = "(no command)";
        let description = "";

        if (t === "exec_command") {
          command = typeof args.cmd === "string" ? args.cmd : "(no command)";
          description =
            typeof args.description === "string" ? args.description : "";
        } else if (t === "write_stdin") {
          const sessionId =
            typeof args.session_id === "string" ||
            typeof args.session_id === "number"
              ? String(args.session_id)
              : "unknown";
          command = `write_stdin ${sessionId}`;
          description =
            typeof args.chars === "string" && args.chars.length > 0
              ? "Write input to running shell session"
              : "Poll running shell session";
        } else {
          command =
            typeof args.command === "string" ? args.command : "(no command)";
          description =
            typeof args.description === "string" ? args.description : "";
        }

        let lines = 3;
        lines += Math.min(
          countWrappedLines(command, wrapWidth),
          SHELL_PREVIEW_MAX_LINES,
        );
        if (description) {
          lines += countWrappedLines(description, wrapWidth);
        }
        return lines;
      }

      if (
        isFileEditTool(toolName) ||
        isFileWriteTool(toolName) ||
        isPatchTool(toolName)
      ) {
        const headerLines = 4;
        let diffLines = 0;
        const toolCallId = approval.toolCallId;

        if (isPatchTool(toolName) && typeof args.input === "string") {
          const operations = parsePatchOperations(args.input);
          operations.forEach((op, idx) => {
            if (idx > 0) diffLines += 1;
            diffLines += 1;

            const diffKey = toolCallId ? `${toolCallId}:${op.path}` : undefined;
            const opDiff =
              diffKey && precomputedDiffsRef.current.has(diffKey)
                ? precomputedDiffsRef.current.get(diffKey)
                : undefined;

            if (opDiff) {
              diffLines += estimateAdvancedDiffLines(opDiff, diffWrapWidth);
              return;
            }

            if (op.kind === "add") {
              diffLines += countWrappedLines(op.content, wrapWidth);
              return;
            }
            if (op.kind === "update") {
              if (op.patchLines?.length) {
                diffLines += countWrappedLinesFromList(
                  op.patchLines,
                  wrapWidth,
                );
              } else {
                diffLines += countWrappedLines(op.oldString || "", wrapWidth);
                diffLines += countWrappedLines(op.newString || "", wrapWidth);
              }
              return;
            }

            diffLines += 1;
          });

          return headerLines + diffLines;
        }

        const diff =
          toolCallId && precomputedDiffsRef.current.has(toolCallId)
            ? precomputedDiffsRef.current.get(toolCallId)
            : undefined;

        if (diff) {
          diffLines += estimateAdvancedDiffLines(diff, diffWrapWidth);
          return headerLines + diffLines;
        }

        if (typeof args.content === "string") {
          diffLines += countWrappedLines(args.content, wrapWidth);
          return headerLines + diffLines;
        }

        const oldString =
          typeof args.old_string === "string" ? args.old_string : "";
        const newString =
          typeof args.new_string === "string" ? args.new_string : "";
        diffLines += countWrappedLines(oldString, wrapWidth);
        diffLines += countWrappedLines(newString, wrapWidth);
        return headerLines + diffLines;
      }

      return 0;
    },
    [columns],
  );

  const shouldEagerCommitApprovalPreview = useCallback(
    (approval: ApprovalRequest): boolean => {
      if (!terminalRows) return false;
      const previewLines = estimateApprovalPreviewLines(approval);
      if (previewLines === 0) return false;
      return (
        previewLines + APPROVAL_OPTIONS_HEIGHT + APPROVAL_PREVIEW_BUFFER >=
        terminalRows
      );
    },
    [estimateApprovalPreviewLines, terminalRows],
  );

  const currentApprovalShouldCommitPreview = useMemo(() => {
    if (!currentApproval) return false;
    return shouldEagerCommitApprovalPreview(currentApproval);
  }, [currentApproval, shouldEagerCommitApprovalPreview]);

  const refreshDerived = useCallback(() => {
    const b = buffersRef.current;
    setTokenCount(b.tokenCount);
    setUsedContextTokens(contextTrackerRef.current.lastContextTokens);
    const newLines = toLines(b);
    setLines(newLines);
    commitEligibleLines(b);
  }, [commitEligibleLines]);
  refreshDerivedRef.current = refreshDerived;

  const handleReload = useCallback(async () => {
    settingsManager.clearCaches();
    await settingsManager.loadProjectSettings();
    await settingsManager.loadLocalProjectSettings();

    const settings = settingsManager.getSettings();
    setTokenStreamingEnabled(settings.tokenStreaming);
    _setReasoningTabCycleEnabled(settings.reasoningTabCycleEnabled === true);
    _setShowCompactionsEnabled(settings.showCompactions === true);

    try {
      refreshCustomCommands();
    } catch (error) {
      debugLog(
        "commands",
        "refreshCustomCommands failed during /reload: %s",
        error instanceof Error ? error.message : String(error),
      );
    }

    const durationMs = Date.now() - sessionStartTimeRef.current;
    void modAdapter.events.emit(
      "conversation_close",
      {
        agentId,
        conversationId: conversationIdRef.current ?? null,
        durationMs,
        messageCount: telemetry.getMessageCount(),
        reason: "reload",
        toolCallCount: telemetry.getToolCallCount(),
      },
      modAdapter.context,
    );
    await modAdapter.reload();
    void modAdapter.events.emit(
      "conversation_open",
      {
        agentId,
        agentName: agentName ?? null,
        conversationId: conversationIdRef.current ?? null,
        reason: "reload",
      },
      modAdapter.context,
    );
    setTerminalTitleConfigRefreshEpoch((epoch) => epoch + 1);
    refreshDerived();
  }, [agentId, agentName, modAdapter, refreshDerived]);

  const recordCommandReminder = useCallback((event: CommandFinishedEvent) => {
    let input = event.input.trim();
    if (!input.startsWith("/")) {
      return;
    }
    if (/^\/secret\s+set\s+/i.test(input)) {
      const parts = input.split(/\s+/);
      if (parts.length >= 4) {
        input = `${parts[0]} ${parts[1]} ${parts[2]} ***`;
      }
    }
    enqueueCommandIoReminder(sharedReminderStateRef.current, {
      input,
      output: event.output,
      success: event.success,
      agentHint: event.agentHint,
    });
  }, []);

  const maybeRecordToolsetChangeReminder = useCallback(
    (params: {
      source: string;
      previousToolset: string | null;
      newToolset: string | null;
      previousTools: string[];
      newTools: string[];
    }) => {
      const toolsetChanged = params.previousToolset !== params.newToolset;
      const previousSnapshot = params.previousTools.join("\n");
      const nextSnapshot = params.newTools.join("\n");
      const toolsChanged = previousSnapshot !== nextSnapshot;
      if (!toolsetChanged && !toolsChanged) {
        return;
      }
      enqueueToolsetChangeReminder(sharedReminderStateRef.current, params);
    },
    [],
  );

  const commandRunner = useMemo(
    () =>
      createCommandRunner({
        buffersRef,
        refreshDerived,
        createId: uid,
        onCommandFinished: recordCommandReminder,
      }),
    [recordCommandReminder, refreshDerived],
  );

  const startOverlayCommand = useCallback(
    (
      overlay: ActiveOverlay,
      input: string,
      openingOutput: string,
      dismissOutput: string,
    ) => {
      const pending = pendingOverlayCommandRef.current;
      if (pending && pending.overlay === overlay) {
        pending.openingOutput = openingOutput;
        pending.dismissOutput = dismissOutput;
        return pending.command;
      }
      const command = commandRunner.start(input, openingOutput);
      pendingOverlayCommandRef.current = {
        overlay,
        command,
        openingOutput,
        dismissOutput,
      };
      return command;
    },
    [commandRunner],
  );

  const consumeOverlayCommand = useCallback((overlay: ActiveOverlay) => {
    const pending = pendingOverlayCommandRef.current;
    if (!pending || pending.overlay !== overlay) {
      return null;
    }
    pendingOverlayCommandRef.current = null;
    return pending.command;
  }, []);

  const openOverlay = useCallback(
    (
      overlay: NonNullable<ActiveOverlay>,
      input: string,
      openingOutput: string,
      dismissOutput: string,
    ) => {
      const cmd = startOverlayCommand(
        overlay,
        input,
        openingOutput,
        dismissOutput,
      );
      setActiveOverlay(overlay);
      return cmd;
    },
    [startOverlayCommand],
  );

  const completeOverlay = useCallback(
    (overlay: NonNullable<ActiveOverlay>) => {
      const cmd = consumeOverlayCommand(overlay);
      setActiveOverlay(null);
      setFeedbackPrefill("");
      setSearchQuery("");
      setModelSelectorOptions({});
      setModelReasoningPrompt(null);
      return cmd;
    },
    [consumeOverlayCommand],
  );

  useEffect(() => {
    const pending = pendingOverlayCommandRef.current;
    if (!pending || pending.overlay !== activeOverlay) {
      return;
    }
    pending.command.update({
      output: pending.openingOutput,
      phase: "waiting",
      dimOutput: true,
    });
  }, [activeOverlay]);

  useEffect(() => {
    if (deferredCommitAt === null) return;
    const delay = Math.max(0, deferredCommitAt - Date.now());
    const timer = setTimeout(() => {
      setDeferredCommitAt(null);
      refreshDerived();
    }, delay);
    return () => clearTimeout(timer);
  }, [deferredCommitAt, refreshDerived]);

  const streamingRefreshTimeoutRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const refreshDerivedStreaming = useCallback(() => {
    if (streamingRefreshTimeoutRef.current) {
      clearTimeout(streamingRefreshTimeoutRef.current);
    }
    streamingRefreshTimeoutRef.current = setTimeout(() => {
      streamingRefreshTimeoutRef.current = null;
      if (!buffersRef.current.interrupted) {
        recordTuiPerf("ui_refresh:tool_output");
        refreshDerived();
      }
    }, 100);
  }, [refreshDerived]);

  useEffect(() => {
    return () => {
      if (streamingRefreshTimeoutRef.current) {
        clearTimeout(streamingRefreshTimeoutRef.current);
      }
    };
  }, []);

  const updateStreamingOutput = useCallback(
    (toolCallId: string, chunk: string, isStderr = false) => {
      recordTuiPerf(`tool_output:${isStderr ? "stderr" : "stdout"}`, {
        bytes: Buffer.byteLength(chunk),
      });

      const lineId = buffersRef.current.toolCallIdToLineId.get(toolCallId);
      if (!lineId) return;

      const entry = buffersRef.current.byId.get(lineId);
      if (!entry || entry.kind !== "tool_call") return;

      const newStreaming = appendStreamingOutput(
        entry.streaming,
        chunk,
        entry.streaming?.startTime || Date.now(),
        isStderr,
      );

      buffersRef.current.byId.set(lineId, {
        ...entry,
        streaming: newStreaming,
      });

      refreshDerivedStreaming();
    },
    [refreshDerivedStreaming],
  );

  const refreshDerivedThrottled = useCallback(() => {
    if (!buffersRef.current.pendingRefresh) {
      buffersRef.current.pendingRefresh = true;
      const capturedGeneration = buffersRef.current.commitGeneration || 0;
      setTimeout(() => {
        buffersRef.current.pendingRefresh = false;
        if (
          !buffersRef.current.interrupted &&
          (buffersRef.current.commitGeneration || 0) === capturedGeneration
        ) {
          recordTuiPerf("ui_refresh:stream");
          refreshDerived();
        }
      }, 16);
    }
  }, [refreshDerived]);

  useEffect(() => {
    if (!currentApproval) return;

    const toolCallId = currentApproval.toolCallId;
    if (!toolCallId) return;
    if (eagerCommittedPreviewsRef.current.has(toolCallId)) return;
    if (!currentApprovalShouldCommitPreview) return;

    const previewItem: StaticItem = {
      kind: "approval_preview",
      id: `approval-preview-${toolCallId}`,
      toolCallId,
      toolName: currentApproval.toolName,
      toolArgs: currentApproval.toolArgs || "{}",
    };

    if (
      (isFileEditTool(currentApproval.toolName) ||
        isFileWriteTool(currentApproval.toolName)) &&
      precomputedDiffsRef.current.has(toolCallId)
    ) {
      previewItem.precomputedDiff = precomputedDiffsRef.current.get(toolCallId);
    }

    setStaticItems((prev) => [...prev, previewItem]);
    eagerCommittedPreviewsRef.current.add(toolCallId);
  }, [currentApproval, currentApprovalShouldCommitPreview]);

  useLayoutEffect(() => {
    if (
      loadingState === "ready" &&
      messageHistory.length > 0 &&
      !hasBackfilledRef.current
    ) {
      hasBackfilledRef.current = true;
      if (!welcomeCommittedRef.current) {
        welcomeCommittedRef.current = true;
        setStaticItems((prev) => [
          ...prev,
          {
            kind: "welcome",
            id: `welcome-${Date.now().toString(36)}`,
            snapshot: {
              continueSession,
              agentState,
              startupHasAvailableLocalModels,
              terminalWidth: columns,
            },
          },
        ]);
      }
      backfillBuffers(buffersRef.current, messageHistory);

      const statusId = `status-resumed-${Date.now().toString(36)}`;

      const isPinned = agentState?.id
        ? settingsManager.isAgentPinned(agentState.id)
        : false;

      const agentName = agentState?.name || "Unnamed Agent";
      const isResumingConversation =
        resumedExistingConversation || messageHistory.length > 0;
      if (isDebugEnabled()) {
        debugLog(
          "app",
          "Header: resumedExistingConversation=%o, messageHistory.length=%d",
          resumedExistingConversation,
          messageHistory.length,
        );
      }
      const headerMessage = isResumingConversation
        ? `Resuming conversation with **${agentName}**`
        : `Starting new conversation with **${agentName}**`;

      const commandHints = buildStartupCommandHints({
        isResumingConversation,
        isPinned,
        isLocalBackend: isLocalBackendEnabled(),
        hasMessages: messageHistory.length > 0,
        hasCloudCredentials: startupHasCloudCredentials,
        hasAvailableLocalModels: startupHasAvailableLocalModels,
      });

      const statusLines: string[] = [];

      const startupSystemPromptWarning =
        buildStartupSystemPromptWarning(agentState);

      if (releaseNotes) {
        statusLines.push(releaseNotes);
        statusLines.push("");
      }

      if (startupSystemPromptWarning) {
        statusLines.push(startupSystemPromptWarning);
      }
      statusLines.push(headerMessage);
      statusLines.push(...commandHints);

      buffersRef.current.byId.set(statusId, {
        kind: "status",
        id: statusId,
        lines: statusLines,
      });
      buffersRef.current.order.push(statusId);

      refreshDerived();
      commitEligibleLines(buffersRef.current, { deferToolCalls: false });
    }
  }, [
    loadingState,
    refreshDerived,
    commitEligibleLines,
    continueSession,
    columns,
    agentState,
    resumedExistingConversation,
    releaseNotes,
    startupHasCloudCredentials,
    startupHasAvailableLocalModels,
    messageHistory,
  ]);

  useEffect(() => {
    if (loadingState === "ready" && agentId && agentId !== "loading") {
      let cancelled = false;

      const fetchConfig = async () => {
        try {
          const backend = getBackend();
          let agent: AgentState;
          if (initialAgentState && initialAgentState.id === agentId) {
            agent = initialAgentState;
          } else {
            agent = await backend.retrieveAgent(agentId);
          }

          setAgentState(agent);
          setLlmConfig(agent.llm_config);
          setAgentDescription(agent.description ?? null);

          try {
            const agentSystem = (agent as { system?: unknown }).system;
            if (typeof agentSystem === "string") {
              const normalize = (s: string) => {
                const withoutMemfs = s.replace(/\n# Memory[\s\S]*$/, "");
                return withoutMemfs.replace(/\r\n/g, "\n").trim();
              };
              const sysNorm = normalize(agentSystem);
              const {
                getSystemPromptVariantContents,
                SYSTEM_PROMPTS,
                SYSTEM_PROMPT,
              } = await import("@/agent/prompt-assets");
              let matched: string | null = null;
              const contentMatches = (content: string): boolean => {
                const norm = normalize(content);
                return (
                  norm === sysNorm ||
                  (norm.length > 0 &&
                    (sysNorm.startsWith(norm) || norm.startsWith(sysNorm)))
                );
              };
              const promptMatches = (
                prompt: (typeof SYSTEM_PROMPTS)[number],
              ): boolean =>
                getSystemPromptVariantContents(prompt).some(contentMatches);

              const defaultPrompt = SYSTEM_PROMPTS.find(
                (p) => p.id === "default",
              );
              if (defaultPrompt && promptMatches(defaultPrompt)) {
                matched = "default";
              } else {
                const found = SYSTEM_PROMPTS.find((p) => promptMatches(p));
                if (found) {
                  matched = found.id;
                } else if (contentMatches(SYSTEM_PROMPT)) {
                  matched = "default";
                }
              }

              setCurrentSystemPromptId(matched ?? "custom");
            } else {
              setCurrentSystemPromptId(
                agentSystem === null ? "default" : "custom",
              );
            }
          } catch {
            setCurrentSystemPromptId("custom");
          }
          const lastRunCompletion = (
            agent as {
              last_run_completion?: string;
            }
          ).last_run_completion;
          setAgentLastRunAt(lastRunCompletion ?? null);

          const agentModelHandle = getPreferredAgentModelHandle(agent);
          const { getModelInfoForLlmConfig } = await import("@/agent/model");
          const modelInfo = getModelInfoForLlmConfig(
            agentModelHandle || "",
            agent.llm_config as unknown as {
              reasoning_effort?: string | null;
              enable_reasoner?: boolean | null;
            },
          );
          if (modelInfo) {
            setCurrentModelId(modelInfo.id);
          } else {
            setCurrentModelId(agentModelHandle || null);
          }
          setCurrentModelHandle(agentModelHandle || null);

          if (backend.capabilities.serverSideToolManagement) {
            const client = await getClient();
            void reconcileExistingAgentState(client, agent)
              .then((reconcileResult) => {
                if (!reconcileResult.updated || cancelled) {
                  return;
                }
                if (agentIdRef.current !== agent.id) {
                  return;
                }

                setAgentState(reconcileResult.agent);
                setAgentDescription(reconcileResult.agent.description ?? null);
              })
              .catch((reconcileError) => {
                debugWarn(
                  "agent-config",
                  `Failed to reconcile existing agent settings for ${agentId}: ${
                    reconcileError instanceof Error
                      ? reconcileError.message
                      : String(reconcileError)
                  }`,
                );
              });
          }
        } catch (error) {
          debugLog("agent-config", "Error fetching agent config: %O", error);
        }
      };
      fetchConfig();

      return () => {
        cancelled = true;
      };
    }
    return undefined;
  }, [loadingState, agentId, initialAgentState]);

  useEffect(() => {
    if (
      !isLocalBackend ||
      loadingState !== "ready" ||
      !agentId ||
      agentId === "loading"
    ) {
      return;
    }

    let cancelled = false;
    let refreshQueued = false;

    const refreshAgentFromRegisteredProviderMetadata = () => {
      if (refreshQueued) return;
      refreshQueued = true;

      queueMicrotask(() => {
        refreshQueued = false;
        const currentAgentId = agentIdRef.current;
        if (cancelled || !currentAgentId || currentAgentId === "loading") {
          return;
        }

        void getBackend()
          .retrieveAgent(currentAgentId)
          .then((agent) => {
            if (cancelled || agentIdRef.current !== agent.id) return;
            setAgentState(agent);
            setAgentDescription(agent.description ?? null);
            setAgentLastRunAt(
              (agent as { last_run_completion?: string | null })
                .last_run_completion ?? null,
            );

            if (
              conversationIdRef.current === "default" &&
              !hasConversationModelOverrideRef.current
            ) {
              const agentModelHandle = getPreferredAgentModelHandle(agent);
              setLlmConfig(agent.llm_config);
              setCurrentModelHandle(agentModelHandle ?? null);
              const modelInfo = getModelInfoForLlmConfig(
                agentModelHandle || "",
                {
                  ...(agent.llm_config as unknown as {
                    reasoning_effort?: string | null;
                    enable_reasoner?: boolean | null;
                  }),
                  context_window:
                    (
                      agent as unknown as {
                        context_window_limit?: number | null;
                      }
                    ).context_window_limit ?? null,
                },
              );
              setCurrentModelId(modelInfo?.id ?? (agentModelHandle || null));
            }
          })
          .catch((error) => {
            debugLog(
              "agent-config",
              "Failed to refresh local agent after provider registry change: %O",
              error,
            );
          });
      });
    };

    if (!modAdapter.isLoading) {
      refreshAgentFromRegisteredProviderMetadata();
    }

    const unsubscribe = subscribePiProviderRegistry(
      refreshAgentFromRegisteredProviderMetadata,
    );
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [
    agentId,
    modAdapter.isLoading,
    hasConversationModelOverrideRef,
    isLocalBackend,
    loadingState,
  ]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: ref.current is intentionally read dynamically
  useEffect(() => {
    if (
      loadingState !== "ready" ||
      !agentId ||
      agentId === "loading" ||
      !agentState
    ) {
      return;
    }

    let cancelled = false;

    const syncToolset = (
      modelHandle: string | null,
      modelSettings: AgentState["model_settings"] | null | undefined,
    ) => {
      const preference = settingsManager.getToolsetPreference(
        agentId,
        conversationId,
      );
      const toolset =
        preference === "auto"
          ? modelHandle
            ? deriveToolsetFromModel(
                modelHandle,
                providerTypeFromModelSettings(modelSettings) ??
                  agentState.llm_config?.model_endpoint_type ??
                  null,
              )
            : null
          : preference;
      setCurrentToolsetPreference(preference);
      setCurrentToolset(toolset);
    };

    const applyAgentModelLocally = () => {
      const agentModelHandle = getPreferredAgentModelHandle(agentState);
      setHasConversationModelOverride(false);
      setConversationOverrideModelSettings(null);
      setConversationOverrideContextWindowLimit(null);
      setLlmConfig(agentState.llm_config);
      setCurrentModelHandle(agentModelHandle ?? null);
      syncToolset(agentModelHandle, agentState.model_settings);

      const currentHandle = buildModelHandleFromLlmConfig(llmConfigRef.current);
      if (agentModelHandle && agentModelHandle === currentHandle) {
        return;
      }

      const modelInfo = getModelInfoForLlmConfig(agentModelHandle || "", {
        ...(agentState.llm_config as unknown as {
          reasoning_effort?: string | null;
          enable_reasoner?: boolean | null;
        }),
        context_window:
          (agentState as unknown as { context_window_limit?: number | null })
            .context_window_limit ?? null,
      });
      setCurrentModelId(modelInfo?.id ?? (agentModelHandle || null));
    };

    const syncConversationModel = async () => {
      if (conversationId === "default") {
        if (!hasConversationModelOverrideRef.current) {
          applyAgentModelLocally();
        }
        return;
      }

      try {
        debugLog(
          "conversations",
          `retrieve(${conversationId}) [syncConversationModel]`,
        );
        const conversation =
          await getBackend().retrieveConversation(conversationId);
        if (cancelled) return;

        const conversationModel = (conversation as { model?: string | null })
          .model;
        const conversationModelSettings = (
          conversation as {
            model_settings?: AgentState["model_settings"] | null;
          }
        ).model_settings;
        const conversationContextWindowLimit = (
          conversation as { context_window_limit?: number | null }
        ).context_window_limit;
        const hasOverride =
          conversationModel !== undefined && conversationModel !== null
            ? true
            : conversationModelSettings !== undefined &&
                conversationModelSettings !== null
              ? true
              : conversationContextWindowLimit !== undefined &&
                conversationContextWindowLimit !== null;

        if (!hasOverride) {
          applyAgentModelLocally();
          return;
        }

        const agentModelHandle = getPreferredAgentModelHandle(agentState);
        const effectiveModelHandle = conversationModel ?? agentModelHandle;
        if (!effectiveModelHandle) {
          applyAgentModelLocally();
          return;
        }

        const hasConversationModelSettings =
          conversationModelSettings !== undefined &&
          conversationModelSettings !== null &&
          Object.keys(conversationModelSettings as Record<string, unknown>)
            .length > 0;
        const resolvedModelSettings = hasConversationModelSettings
          ? conversationModelSettings
          : conversationModel === undefined ||
              conversationModel === null ||
              conversationModel === agentModelHandle
            ? (agentState.model_settings ?? null)
            : null;

        const reasoningEffort = deriveReasoningEffort(
          resolvedModelSettings,
          agentState.llm_config,
        );
        const conversationServiceTier =
          (
            resolvedModelSettings as
              | { service_tier?: unknown }
              | null
              | undefined
          )?.service_tier === CHATGPT_FAST_SERVICE_TIER &&
          getChatGptFastRegistryHandleForModelHandle(effectiveModelHandle)
            ? CHATGPT_FAST_SERVICE_TIER
            : null;

        const modelInfo = getModelInfoForLlmConfig(effectiveModelHandle, {
          reasoning_effort: reasoningEffort,
          enable_reasoner:
            (
              agentState.llm_config as {
                enable_reasoner?: boolean | null;
              }
            ).enable_reasoner ?? null,
          context_window: conversationContextWindowLimit ?? null,
          service_tier: conversationServiceTier,
        });
        const modelPresetContextWindow = (
          modelInfo?.updateArgs as { context_window?: unknown } | undefined
        )?.context_window;
        const resolvedConversationContextWindowLimit =
          conversationContextWindowLimit === undefined
            ? typeof modelPresetContextWindow === "number"
              ? modelPresetContextWindow
              : null
            : conversationContextWindowLimit;

        setHasConversationModelOverride(true);
        setConversationOverrideModelSettings(resolvedModelSettings);
        setConversationOverrideContextWindowLimit(
          resolvedConversationContextWindowLimit,
        );
        setCurrentModelHandle(effectiveModelHandle);
        setCurrentModelId(modelInfo?.id ?? effectiveModelHandle);
        setLlmConfig({
          ...agentState.llm_config,
          ...mapHandleToLlmConfigPatch(
            effectiveModelHandle,
            providerTypeFromModelSettings(resolvedModelSettings),
          ),
          ...reasoningEffortLlmConfigPatch(
            resolvedModelSettings,
            agentState.llm_config,
          ),
          ...(typeof resolvedConversationContextWindowLimit === "number"
            ? { context_window: resolvedConversationContextWindowLimit }
            : {}),
        } as LlmConfig);
        syncToolset(effectiveModelHandle, resolvedModelSettings);
      } catch (error) {
        if (cancelled) return;
        debugLog(
          "conversation-model",
          "Failed to sync conversation model override: %O",
          error,
        );
        debugLog(
          "conversation-model",
          "Keeping current model state after sync error (override in DB is authoritative)",
        );
      }
    };

    void syncConversationModel();

    return () => {
      cancelled = true;
    };
  }, [
    agentId,
    agentState,
    conversationId,
    loadingState,
    setHasConversationModelOverride,
  ]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refs are stable objects, .current is read dynamically
  const maybeCarryOverActiveConversationModel = useCallback(
    async (targetConversationId: string) => {
      if (!hasConversationModelOverrideRef.current) return;

      const currentLlmConfig = llmConfigRef.current;
      const rawModelHandle =
        currentModelHandleRef.current ??
        buildModelHandleFromLlmConfig(currentLlmConfig);
      if (!rawModelHandle) {
        return;
      }

      const carryover = buildConversationModelCarryoverUpdate({
        rawModelHandle,
        currentLlmConfig,
        activeConversationContextWindowLimit:
          conversationOverrideContextWindowLimitRef.current,
      });
      if (!carryover) return;

      try {
        const { updateConversationLLMConfig } = await import("@/agent/modify");
        await updateConversationLLMConfig(
          targetConversationId,
          carryover.modelHandle,
          carryover.updateArgs,
          carryover.contextWindowOverride !== undefined
            ? { contextWindowOverride: carryover.contextWindowOverride }
            : undefined,
        );
      } catch (error) {
        debugWarn(
          "conversation-model",
          `Failed to carry over active model to new conversation: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    },
    [],
  );

  const appendError = useCallback(
    (
      message: string,
      options?:
        | boolean
        | {
            skip?: boolean;
            errorType?: string;
            errorMessage?: string;
            context?: string;
            httpStatus?: number;
            runId?: string;
          },
    ) => {
      const text =
        typeof message === "string"
          ? message
          : message != null
            ? JSON.stringify(message)
            : "[Unknown error]";

      const id = uid("err");
      buffersRef.current.byId.set(id, {
        kind: "error",
        id,
        text,
      });
      buffersRef.current.order.push(id);
      refreshDerived();

      const skip =
        typeof options === "boolean" ? options : (options?.skip ?? false);
      if (!skip) {
        const opts = typeof options === "object" ? options : undefined;
        telemetry.trackError(
          opts?.errorType || "ui_error",
          opts?.errorMessage || text,
          opts?.context || "error_display",
          {
            httpStatus: opts?.httpStatus,
            modelId: currentModelId || undefined,
            runId: opts?.runId,
            recentChunks: chunkLog.getEntries(),
          },
        );
      }
    },
    [refreshDerived, currentModelId],
  );

  const updateMemorySyncCommand = useCallback(
    (
      commandId: string,
      output: string,
      success: boolean,
      input = "/memfs sync",
      keepRunning = false,
    ) => {
      buffersRef.current.byId.set(commandId, {
        kind: "command",
        id: commandId,
        input,
        output,
        phase: keepRunning ? "running" : "finished",
        success,
      });
      refreshDerived();
    },
    [refreshDerived],
  );

  useEffect(() => {
    if (loadingState !== "ready") {
      return;
    }
    if (!agentId || agentId === "loading") {
      return;
    }
    if (memoryFilesystemInitializedRef.current) {
      return;
    }
    if (!settingsManager.isMemfsEnabled(agentId)) {
      return;
    }

    memoryFilesystemInitializedRef.current = true;

    (async () => {
      try {
        if (getBackend().capabilities.localMemfs) {
          const { initializeLocalMemoryRepo } = await import(
            "@/agent/memory-git"
          );
          await initializeLocalMemoryRepo({
            memoryDir: getScopedMemoryFilesystemRoot(agentId),
            agentId,
            authorName: agentName ?? undefined,
            files: [],
          });
          return;
        }

        const { isGitRepo, cloneMemoryRepo, pullMemory } = await import(
          "@/agent/memory-git"
        );
        if (!isGitRepo(agentId)) {
          await cloneMemoryRepo(agentId);
        } else {
          await pullMemory(agentId);
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        debugWarn("memfs-git", `Startup sync failed: ${errMsg}`);
        appendError(`Memory git sync failed: ${errMsg}`);
        pendingGitReminderRef.current = {
          dirty: false,
          aheadOfRemote: false,
          summary: `Git memory sync failed on startup: ${errMsg}\nMemory may be stale. Try running: git -C ${getScopedMemoryFilesystemRoot(agentId)} pull`,
        };
      }
    })();
  }, [agentId, agentName, loadingState, appendError]);

  useEffect(() => {
    if (!agentId || agentId === "loading") return;
    if (!settingsManager.isMemfsEnabled(agentId)) return;

    let watcher: ReturnType<typeof import("node:fs").watch> | null = null;

    (async () => {
      try {
        const { watch } = await import("node:fs");
        const { existsSync } = await import("node:fs");
        const memRoot = getScopedMemoryFilesystemRoot(agentId);
        if (!existsSync(memRoot)) return;

        watcher = watch(memRoot, { recursive: true }, () => {});
        memfsWatcherRef.current = watcher;
        debugLog("memfs", `Watching memory directory: ${memRoot}`);

        watcher.on("error", (err) => {
          debugWarn(
            "memfs",
            "fs.watch error (falling back to interval check)",
            err,
          );
        });
      } catch (err) {
        debugWarn(
          "memfs",
          "Failed to set up fs.watch (falling back to interval check)",
          err,
        );
      }
    })();

    return () => {
      if (watcher) {
        watcher.close();
      }
      if (memfsWatcherRef.current) {
        memfsWatcherRef.current = null;
      }
    };
  }, [agentId]);

  const maybeRunPostTurnReflection = useCallback(async (): Promise<void> => {
    const reflectionAgentId = agentIdRef.current;
    if (!reflectionAgentId || reflectionAgentId === "loading") {
      return;
    }
    try {
      const reflectionSettings = getReflectionSettings(reflectionAgentId);
      await maybeLaunchPostTurnReflection({
        agentId: reflectionAgentId,
        conversationId: conversationIdRef.current ?? "default",
        memfsEnabled: isActiveMemfsEnabled(reflectionAgentId),
        reflectionSettings,
        reminderState: sharedReminderStateRef.current,
        contextTracker: contextTrackerRef.current,
        launch: async (triggerSource) => {
          if (experimentManager.isEnabled("reflection_arena")) {
            const arenaResult = await launchReflectionArena({
              agentId: reflectionAgentId,
              conversationId: conversationIdRef.current ?? "default",
              triggerSource,
              models: [
                REFLECTION_ARENA_MODEL_A_DEFAULT,
                sampleReflectionArenaComparisonModel(),
              ],
              feedbackContext: {
                parentAgentName: agentName,
                parentAgentDescription: agentDescription,
                surface: "letta_code_tui",
              },
              onReady: (message, readyRun) => {
                appendTaskNotificationEvents([message]);
                setReflectionArenaChoicePending({
                  runId: readyRun.runId,
                  questions: buildReflectionArenaChoiceQuestions(
                    readyRun.runId,
                  ),
                });
              },
            });
            return arenaResult.launched;
          }

          const result = await launchReflectionSubagent({
            agentId: reflectionAgentId,
            conversationId: conversationIdRef.current ?? "default",
            memfsEnabled: isActiveMemfsEnabled(reflectionAgentId),
            triggerSource,
            reflectionSettings,
            description: AUTO_REFLECTION_DESCRIPTION,
            completionConversationId: () => conversationIdRef.current,
            recompileByConversation:
              _systemPromptRecompileByConversationRef.current,
            recompileQueuedByConversation:
              _queuedSystemPromptRecompileByConversationRef.current,
            onCompletionMessage: (completionMessage) => {
              appendTaskNotificationEvents([completionMessage]);
            },
            feedbackContext: {
              parentAgentName: agentName,
              parentAgentDescription: agentDescription,
              surface: "letta_code_tui",
            },
          });
          return result.launched;
        },
      });
    } catch (error) {
      debugWarn(
        "memory",
        `Failed to evaluate post-turn reflection: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }, [agentName, agentDescription, appendTaskNotificationEvents]);

  const processConversation = useConversationLoop({
    abortControllerRef,
    agentIdRef,
    appendError,
    appendTaskNotificationEvents,
    approvalToolContextIdRef,
    autoAllowedExecutionRef,
    buffersRef,
    clearApprovalToolContext,
    chatgptPlanSwapsRef,
    chatgptExhaustedProvidersRef,
    closeTrajectorySegment,
    consumeQueuedMessages,
    queueModeRef,
    contextTrackerRef,
    conversationBusyRetriesRef,
    conversationGenerationRef,
    conversationIdRef,
    currentModelId,
    emptyResponseRetriesRef,
    executingToolCallIdsRef,
    generateConversationDescription,
    modAdapter,
    generateConversationTitle,
    hasConversationModelOverrideRef,
    interruptQueuedRef,
    isAutoConversationTitleInFlightRef,
    lastDequeuedMessageRef,
    lastRunIdRef,
    lastSentInputRef,
    llmApiErrorRetriesRef,
    llmConfigRef,
    maybeRunPostTurnReflection,
    needsEagerApprovalCheck,
    openTrajectorySegment,
    pendingInterruptRecoveryConversationIdRef,
    pendingTranscriptStartLineIndexRef,
    precomputedDiffsRef,
    prepareScopedToolExecutionContext,
    processingConversationRef,
    releasedGenerationRef,
    staleTurnUnwindingRef,
    queuedApprovalResultsRef,
    queueApprovalResults,
    queueSnapshotRef,
    refreshDerived,
    refreshDerivedThrottled,
    resetTrajectoryBases,
    restoreQueueOnCancelRef,
    sessionStatsRef,
    setAgentDescription,
    setAgentLastRunAt,
    setAgentState,
    setApprovalContexts,
    setApprovalResults,
    setAutoDeniedApprovals,
    setAutoHandledResults,
    setCurrentModelHandle,
    setCurrentModelId,
    setDequeueEpoch,
    setInterruptRequested,
    lastStopReasonRef,
    setIsExecutingTool,
    setLlmConfig,
    setNeedsEagerApprovalCheck,
    setNetworkPhase,
    setExecutionPhase,
    setPendingApprovals,
    setRestoreQueueOnCancel,
    setRestoredInput,
    setStreaming,
    setConversationSummary,
    setTempModelOverride,
    setThinkingMessage,
    setTrajectoryElapsedBaseMs,
    setTrajectoryTokenBase,
    setUiPermissionMode,
    shouldAutoGenerateConversationTitleRef,
    syncTrajectoryElapsedBase,
    syncTrajectoryTokenBase,
    tempModelOverrideRef,
    toolAbortControllerRef,
    toolResultsInFlightRef,
    trajectoryRunTokenStartRef,
    trajectorySegmentStartRef,
    trajectoryTokenDisplayRef,
    tuiQueueRef,
    uiPermissionModeRef,
    updateStreamingOutput,
    userCancelledRef,
    waitingForQueueCancelRef,
  });

  const {
    recoverRestoredPendingApprovals,
    handleApproveCurrent,
    handleApproveAlways,
    handleDenyCurrent,
    handleCancelApprovals,
  } = useApprovalFlow({
    abortControllerRef,
    agentId,
    appendError,
    appendTaskNotificationEvents,
    approvalContexts,
    approvalResults,
    approvalToolContextIdRef,
    autoDeniedApprovals,
    autoHandledResults,
    buffersRef,
    clearApprovalToolContext,
    closeTrajectorySegment,
    commandRunner,
    commitEligibleLines,
    consumeQueuedMessages,
    queueModeRef,
    conversationGenerationRef,
    conversationId,
    conversationIdRef,
    executingToolCallIdsRef,
    interruptQueuedRef,
    isExecutingTool,
    loadingState,
    openTrajectorySegment,
    pendingApprovals,
    precomputedDiffsRef,
    prepareScopedToolExecutionContext,
    processConversation,
    queueApprovalResults,
    queueSnapshotRef,
    queuedApprovalMetadataRef,
    queuedApprovalResultsRef,
    refreshDerived,
    restoredApprovalRecoveryRef,
    sessionStatsRef,
    setApprovalContexts,
    setApprovalResults,
    setAutoDeniedApprovals,
    setAutoHandledResults,
    setIsExecutingTool,
    setNeedsEagerApprovalCheck,
    setPendingApprovals,
    setStreaming,
    setThinkingMessage,
    setUiPermissionMode,
    startupApproval,
    startupApprovals,
    syncTrajectoryElapsedBase,
    tempModelOverrideRef,
    toolAbortControllerRef,
    toolResultsInFlightRef,
    updateStreamingOutput,
    userCancelledRef,
    waitingForQueueCancelRef,
  });

  const handleExit = useCallback(async () => {
    await prepareSessionExit(conversationIdRef.current);

    await runEndHooks();

    const stats = sessionStatsRef.current.getSnapshot();
    telemetry.trackSessionEnd(stats, "exit_command");

    try {
      recordSessionEnd(
        agentId,
        telemetry.getSessionId(),
        stats,
        {
          project: projectDirectory,
          model: currentModelLabel ?? "",
          provider: currentModelProvider ?? "",
        },
        undefined,
        {
          messageCount: telemetry.getMessageCount(),
          toolCallCount: telemetry.getToolCallCount(),
          exitReason: "exit_command",
        },
      );
    } catch {}

    await closeMcp();
    await telemetry.flush();

    setShowExitStats(true);
    setTimeout(() => {
      process.exit(0);
    }, 100);
  }, [
    runEndHooks,
    agentId,
    projectDirectory,
    currentModelLabel,
    currentModelProvider,
  ]);

  const handleQueueEdit = useCallback((): string => {
    const userMessages = queueDisplay.filter((m) => m.kind === "user");
    if (userMessages.length === 0) return "";

    const removedTexts: string[] = [];
    for (const msg of userMessages) {
      if (msg.queueItemId) {
        const removed = tuiQueueRef.current?.removeItem(msg.queueItemId);
        if (removed) {
          removedTexts.push(msg.text);
        }
      } else {
        removedTexts.push(msg.text);
      }
    }

    if (removedTexts.length === 0) return "";

    setQueueDisplay((prev) => prev.filter((m) => m.kind !== "user"));

    return removedTexts.join("\n");
  }, [queueDisplay]);

  const handlePasteError = useCallback(
    (message: string) => {
      const statusId = uid("status");
      buffersRef.current.byId.set(statusId, {
        kind: "status",
        id: statusId,
        lines: [`⚠️ ${message}`],
      });
      buffersRef.current.order.push(statusId);
      refreshDerived();
    },
    [refreshDerived],
  );

  const { handleInterrupt } = useInterruptHandler({
    abortControllerRef,
    agentId,
    agentIdRef,
    appendError,
    autoAllowedExecutionRef,
    autoDeniedApprovals,
    autoHandledResults,
    buffersRef,
    conversationGenerationRef,
    conversationIdRef,
    executingToolCallIdsRef,
    interruptQueuedRef,
    interruptRequested,
    isExecutingTool,
    pendingApprovals,
    pendingInterruptRecoveryConversationIdRef,
    processingConversationRef,
    releasedGenerationRef,
    staleTurnUnwindingRef,
    queueApprovalResults,
    refreshDerived,
    resetTrajectoryBases,
    setApprovalContexts,
    setApprovalResults,
    setAutoDeniedApprovals,
    setAutoHandledResults,
    setDequeueEpoch,
    setInterruptRequested,
    setIsExecutingTool,
    setPendingApprovals,
    setRestoreQueueOnCancel,
    setStreaming,
    streaming,
    toolAbortControllerRef,
    toolResultsInFlightRef,
    tuiQueueRef,
    userCancelledRef,
    waitingForQueueCancelRef,
  });

  const processConversationRef = useRef(processConversation);
  useEffect(() => {
    processConversationRef.current = processConversation;
  }, [processConversation]);

  const reasoningCycleDebounceMs = 500;
  const reasoningCycleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const reasoningCycleInFlightRef = useRef(false);
  const reasoningCycleDesiredRef = useRef<{
    modelHandle: string;
    effort: ModelReasoningSelection;
    modelId: string;
    providerType?: string | null;
    serviceTier?: string | null;
  } | null>(null);
  const reasoningCycleLastConfirmedRef = useRef<LlmConfig | null>(null);
  const reasoningCycleLastConfirmedAgentStateRef = useRef<AgentState | null>(
    null,
  );
  const reasoningCyclePatchedAgentStateRef = useRef(false);

  const resetPendingReasoningCycle = useCallback(() => {
    if (reasoningCycleTimerRef.current) {
      clearTimeout(reasoningCycleTimerRef.current);
      reasoningCycleTimerRef.current = null;
    }
    reasoningCycleDesiredRef.current = null;
    reasoningCycleLastConfirmedRef.current = null;
    reasoningCycleLastConfirmedAgentStateRef.current = null;
    reasoningCyclePatchedAgentStateRef.current = false;
  }, []);

  const {
    handleBtwCommand,
    handleBtwJump,
    handleAgentSelect,
    handleCreateNewAgent,
  } = useConversationSwitching({
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
  });

  const { handleBashSubmit, handleBashInterrupt } = useBashHandlers({
    bashAbortControllerRef,
    bashCommandCacheRef,
    bashRunning,
    buffersRef,
    refreshDerived,
    refreshDerivedStreaming,
    setBashRunning,
  });

  const {
    checkPendingApprovalsForSlashCommand,
    consumeQueuedApprovalInputForCurrentConversation,
    processConversationWithQueuedApprovals,
  } = useQueuedApprovalSubmit({
    agentId,
    conversationGenerationRef,
    conversationIdRef,
    interruptQueuedRef,
    needsEagerApprovalCheck,
    processConversation,
    queueApprovalResults,
    queuedApprovalMetadataRef,
    queuedApprovalResultsRef,
    setNeedsEagerApprovalCheck,
  });

  const handleReflectionArenaChoiceSubmit = useCallback(
    async (answers: Record<string, string>) => {
      const pending = reflectionArenaChoicePending;
      if (!pending) return;
      setReflectionArenaChoicePending(null);
      setCommandRunning(true);
      try {
        const answer = parseReflectionArenaChoiceAnswers(answers);
        const { message } = await finalizeReflectionArenaChoice({
          runId: pending.runId,
          choice: answer.choice,
          notes: answer.notes,
          onHfUploadComplete: (message) => {
            appendTaskNotificationEvents([message]);
          },
          recompileByConversation:
            _systemPromptRecompileByConversationRef.current,
          recompileQueuedByConversation:
            _queuedSystemPromptRecompileByConversationRef.current,
        });
        appendTaskNotificationEvents([message]);
      } catch (error) {
        appendTaskNotificationEvents([
          `Failed to record reflection arena choice: ${formatErrorDetails(error, agentId)}`,
        ]);
      } finally {
        setCommandRunning(false);
      }
    },
    [
      reflectionArenaChoicePending,
      setCommandRunning,
      appendTaskNotificationEvents,
      agentId,
    ],
  );

  const handleReflectionArenaChoiceCancel = useCallback(() => {
    const pending = reflectionArenaChoicePending;
    setReflectionArenaChoicePending(null);
    if (pending) {
      appendTaskNotificationEvents([
        formatReflectionArenaDeferredMessage(pending.runId),
      ]);
    }
  }, [reflectionArenaChoicePending, appendTaskNotificationEvents]);

  const onSubmit = useSubmitHandler({
    abortControllerRef,
    agentDescription,
    agentId,
    agentIdRef,
    agentLastRunAt,
    agentName,
    agentState,
    agentStateRef,
    appendTaskNotificationEvents,
    bashCommandCacheRef,
    buffersRef,
    checkPendingApprovalsForSlashCommand,
    commandRunner,
    commandRunning,
    consumeQueuedApprovalInputForCurrentConversation,
    contextTrackerRef,
    conversationGenerationRef,
    conversationId,
    conversationIdRef,
    currentModelHandle,
    currentModelId,
    currentModelLabel,
    currentModelProvider,
    effectiveContextWindowSize,
    emittedIdsRef,
    modAdapter,
    firstUserQueryRef,
    flushPendingReasoningEffort: () => flushPendingReasoningEffort(),
    generateConversationDescription,
    generateConversationTitle,
    handleAgentSelect,
    handleBtwCommand,
    handleExit,
    hasBackfilledRef,
    isAgentBusy,
    isExecutingTool,
    llmConfigRef,
    maybeCarryOverActiveConversationModel,
    needsEagerApprovalCheck,
    openTrajectorySegment,
    overrideContentPartsRef,
    pendingApprovals,
    pendingConversationSwitchRef,
    pendingGitReminderRef,
    processConversation,
    processConversationWithQueuedApprovals,
    profileConfirmPending,
    projectDirectory,
    queuedApprovalResults,
    queuedSystemPromptRecompileByConversationRef:
      _queuedSystemPromptRecompileByConversationRef,
    reasoningTabCycleEnabled,
    recoverRestoredPendingApprovals,
    refreshDerived,
    resetBootstrapReminderState,
    resetDeferredToolCallCommits,
    resetPendingReasoningCycle,
    resetTrajectoryBases,
    runEndHooks,
    sessionHooksRanRef,
    sessionStartFeedbackRef,
    sessionStatsRef,
    openOverlay,
    setAgentDescription,
    setAgentState,
    setCommandRunning,
    setConversationAutoTitleEligibility,
    setConversationIdAndRef,
    setConversationSummary,
    setConversationOverrideContextWindowLimit,
    setConversationOverrideModelSettings,
    setCurrentPersonalityId,
    setDequeueEpoch,
    setFeedbackPrefill,
    setHasConversationModelOverride,
    setLines,
    setLlmConfig,
    markLocalModelsAvailable,
    setModelSelectorOptions,
    setNeedsEagerApprovalCheck,
    setProfileConfirmPending,
    setReflectionArenaChoicePending,
    setWorktreeDiffSelectorPending,
    setReasoningTabCycleEnabled: _setReasoningTabCycleEnabled,
    setSearchQuery,
    setStaticItems,
    setStaticRenderEpoch,
    setStreaming,
    setThinkingMessage,
    setTokenStreamingEnabled,
    setTrajectoryTokenBase,
    sharedReminderStateRef,
    shouldAutoGenerateConversationTitleRef,
    streaming,
    systemInfoReminderEnabled,
    systemPromptRecompileByConversationRef:
      _systemPromptRecompileByConversationRef,
    tokenStreamingEnabled,
    trajectoryRunTokenStartRef,
    trajectoryTokenDisplayRef,
    tuiQueueRef,
    updateAgentName,
    updateMemorySyncCommand,
    userCancelledRef,
    onReload: handleReload,
  });

  const onSubmitRef = useRef(onSubmit);
  useEffect(() => {
    onSubmitRef.current = onSubmit;
  }, [onSubmit]);

  useEffect(() => {
    void dequeueEpoch;

    const queueLen = tuiQueueRef.current?.readyLength ?? 0;
    const hasAnythingQueued = queueLen > 0;
    if (!hasAnythingQueued && (tuiQueueRef.current?.length ?? 0) > 0) {
      tuiQueueRef.current?.tryDequeue("paused_by_user");
    }

    if (
      !streaming &&
      hasAnythingQueued &&
      !queuedOverlayAction &&
      pendingApprovals.length === 0 &&
      !commandRunning &&
      !isExecutingTool &&
      !reflectionArenaChoicePending &&
      !anySelectorOpen &&
      !waitingForQueueCancelRef.current &&
      !userCancelledRef.current &&
      !abortControllerRef.current &&
      !dequeueInFlightRef.current &&
      (queueMode === "immediate" ||
        (lastStopReasonRef.current === "end_turn" &&
          processingConversationRef.current === 0))
    ) {
      const batch = tuiQueueRef.current?.consumeItems(queueLen);
      if (!batch) return;

      const {
        text: concatenatedMessage,
        content: queuedContentParts,
        submitOptions,
      } = prepareTuiQueueSubmit(batch);

      debugLog(
        "queue",
        `Dequeuing ${batch.mergedCount} message(s): "${concatenatedMessage.slice(0, 50)}${concatenatedMessage.length > 50 ? "..." : ""}"`,
      );

      lastDequeuedMessageRef.current = concatenatedMessage;

      overrideContentPartsRef.current = queuedContentParts;
      dequeueInFlightRef.current = true;
      setQueueMode("immediate");
      void onSubmitRef
        .current(concatenatedMessage, submitOptions)
        .finally(() => {
          dequeueInFlightRef.current = false;
          if ((tuiQueueRef.current?.length ?? 0) > 0) {
            setDequeueEpoch((e) => e + 1);
          }
        });
    } else if (hasAnythingQueued) {
      debugLog(
        "queue",
        `Dequeue blocked: streaming=${streaming}, queuedOverlayAction=${!!queuedOverlayAction}, pendingApprovals=${pendingApprovals.length}, commandRunning=${commandRunning}, isExecutingTool=${isExecutingTool}, anySelectorOpen=${anySelectorOpen}, waitingForQueueCancel=${waitingForQueueCancelRef.current}, userCancelled=${userCancelledRef.current}, abortController=${!!abortControllerRef.current}`,
      );
      const blockedReason = getTuiBlockedReason({
        streaming,
        isExecutingTool,
        commandRunning,
        pendingApprovalsLen: pendingApprovals.length,
        queuedOverlayAction: !!queuedOverlayAction,
        anySelectorOpen,
        waitingForQueueCancel: waitingForQueueCancelRef.current,
        userCancelled: userCancelledRef.current,
        abortControllerActive: !!abortControllerRef.current,
      });
      if (blockedReason) {
        tuiQueueRef.current?.tryDequeue(blockedReason);
      }
    }
  }, [
    streaming,
    pendingApprovals,
    commandRunning,
    isExecutingTool,
    reflectionArenaChoicePending,
    anySelectorOpen,
    dequeueEpoch,
    queuedOverlayAction,
    queueMode,
  ]);

  const {
    handleModelSelect,
    handleSystemPromptSelect,
    handlePersonalitySelect,
    handleSleeptimeModeSelect,
    handleCompactionModeSelect,
    handleToolsetSelect,
    handleExperimentSelect,
    handleExperimentsConfirm,
  } = useConfigurationHandlers({
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
    currentReasoningEffort,
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
  });

  useEffect(() => {
    if (
      !streaming &&
      !commandRunning &&
      !isExecutingTool &&
      pendingApprovals.length === 0 &&
      queuedOverlayAction !== null
    ) {
      const action = queuedOverlayAction;
      setQueuedOverlayAction(null);

      if (action.type === "switch_agent") {
        handleAgentSelect(action.agentId, {
          commandId: action.commandId,
          backendMode: action.backendMode,
        });
      } else if (action.type === "switch_model") {
        handleModelSelect(
          action.modelSelection ?? action.modelId,
          action.commandId,
        );
      } else if (action.type === "set_sleeptime") {
        handleSleeptimeModeSelect(action.settings, action.commandId);
      } else if (action.type === "set_compaction") {
        handleCompactionModeSelect(action.mode, action.commandId);
      } else if (action.type === "switch_conversation") {
        const cmd = action.commandId
          ? commandRunner.getHandle(action.commandId, "/resume")
          : commandRunner.start(
              "/resume",
              "Processing queued conversation switch...",
            );
        cmd.update({
          output: "Processing queued conversation switch...",
          phase: "running",
        });

        (async () => {
          setCommandRunning(true);
          try {
            if (action.conversationId === conversationId) {
              cmd.finish("Already on this conversation", true);
            } else {
              if (agentState) {
                const resumeData = await getResumeDataFromBackend(
                  agentState,
                  action.conversationId,
                );

                setConversationIdAndRef(action.conversationId);
                setConversationAutoTitleEligibility(false);

                pendingConversationSwitchRef.current = {
                  origin: "resume-selector",
                  conversationId: action.conversationId,
                  isDefault: action.conversationId === "default",
                  messageCount: resumeData.messageHistory.length,
                  messageHistory: resumeData.messageHistory,
                };

                settingsManager.persistSession(agentId, action.conversationId);

                resetContextHistory(contextTrackerRef.current);
                resetBootstrapReminderState();

                if (resumeData.pendingApprovals.length > 0) {
                  await recoverRestoredPendingApprovals(
                    resumeData.pendingApprovals,
                  );
                }

                cmd.finish(
                  `Switched to conversation (${resumeData.messageHistory.length} messages)`,
                  true,
                );
              }
            }
          } catch (error) {
            cmd.fail(
              `Failed to switch conversation: ${error instanceof Error ? error.message : String(error)}`,
            );
          } finally {
            setCommandRunning(false);
            refreshDerived();
          }
        })();
      } else if (action.type === "switch_toolset") {
        handleToolsetSelect(action.toolsetId, action.commandId);
      } else if (action.type === "set_experiment") {
        handleExperimentSelect(
          {
            experimentId: action.experimentId,
            enabled: action.enabled,
          },
          action.commandId,
        );
      } else if (action.type === "switch_system") {
        handleSystemPromptSelect(action.promptId, action.commandId);
      } else if (action.type === "switch_personality") {
        handlePersonalitySelect(action.personalityId, action.commandId);
      }
    }
  }, [
    streaming,
    commandRunning,
    isExecutingTool,
    pendingApprovals,
    handleAgentSelect,
    handleModelSelect,
    handleSleeptimeModeSelect,
    handleCompactionModeSelect,
    handleToolsetSelect,
    handleExperimentSelect,
    handleSystemPromptSelect,
    handlePersonalitySelect,
    agentId,
    agentState,
    conversationId,
    refreshDerived,
    setCommandRunning,
    commandRunner.getHandle,
    commandRunner.start,
    recoverRestoredPendingApprovals,
    resetBootstrapReminderState,
    setConversationAutoTitleEligibility,
    setConversationIdAndRef,
    queuedOverlayAction,
  ]);

  const { handleFeedbackSubmit } = useFeedbackHandler({
    agentDescription,
    agentId,
    agentName,
    billingTier,
    completeOverlay,
    commandRunner,
    currentModelId,
    lastRunIdRef,
    sessionStatsRef,
    withCommandLock,
  });

  const handleProfileEscapeCancel = useCallback(() => {
    if (profileConfirmPending) {
      const { cmdId, name } = profileConfirmPending;
      const cmd = commandRunner.getHandle(cmdId, `/profile load ${name}`);
      cmd.fail("Cancelled");
      setProfileConfirmPending(null);
    }
  }, [commandRunner, profileConfirmPending]);

  const handleToggleExpandedToolCall = useCallback((id: string) => {
    setExpandedToolCallId((prev) => (prev === id ? null : id));
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: lines triggers recompute when buffer changes
  const lastShellToolCallId = useMemo(() => {
    const order = buffersRef.current.order;
    for (let i = order.length - 1; i >= 0; i--) {
      const id = order[i];
      if (!id) continue;
      const ln = buffersRef.current.byId.get(id);
      if (
        ln?.kind === "tool_call" &&
        ln.phase === "finished" &&
        ln.resultText &&
        ln.name &&
        isShellOutputTool(ln.name)
      ) {
        return id;
      }
    }
    return null;
  }, [lines]);

  const handleCtrlO = useCallback(() => {
    if (lastShellToolCallId) {
      handleToggleExpandedToolCall(lastShellToolCallId);
    }
  }, [lastShellToolCallId, handleToggleExpandedToolCall]);

  const handlePermissionModeChange = useCallback(
    (mode: PermissionMode) => {
      setUiPermissionMode(mode);
    },
    [setUiPermissionMode],
  );

  const { flushPendingReasoningEffort, handleCycleReasoningEffort } =
    useReasoningCycle({
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
    });

  // biome-ignore lint/correctness/useExhaustiveDependencies: staticItems.length and deferredCommitAt are intentional triggers to recompute when items are promoted to static or deferred commits complete
  const liveItems = useMemo(() => {
    return lines.filter((ln) => {
      if (!("phase" in ln)) return false;
      if (emittedIdsRef.current.has(ln.id)) return false;
      if (ln.kind === "command" || ln.kind === "bash_command") {
        return ln.phase === "running";
      }
      if (ln.kind === "tool_call") {
        if (ln.name && isTaskTool(ln.name)) {
          return ln.phase === "ready" || ln.phase === "streaming";
        }
        return (
          ln.phase !== "finished" ||
          deferredToolCallCommitsRef.current.has(ln.id)
        );
      }
      if (ln.kind === "event") {
        if (!showCompactionsEnabled && ln.eventType === "compaction")
          return false;
        return ln.phase === "running";
      }
      if (!tokenStreamingEnabled && ln.phase === "streaming") return false;
      return ln.phase === "streaming";
    });
  }, [
    lines,
    tokenStreamingEnabled,
    showCompactionsEnabled,
    staticItems.length,
    deferredCommitAt,
  ]);

  const { agents: subagents } = useSyncExternalStore(
    subscribeToSubagents,
    getSubagentSnapshot,
  );

  const hasStopFailedTasks = hasStopFailedSubagents({
    agentId,
    conversationId,
  });
  const stopFailedNotifiedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const { failures, stops } = selectStopFailedNotifications(
      subagents,
      stopFailedNotifiedRef.current,
      { agentId, conversationId },
    );
    const messages = [...failures, ...stops];
    if (messages.length > 0) {
      appendTaskNotificationEvents(messages);
    }
  }, [subagents, conversationId, appendTaskNotificationEvents, agentId]);

  const estimatedLiveHeight = useMemo(() => {
    const countLines = (text: string | undefined): number => {
      if (!text) return 0;
      return (text.match(/\n/g) || []).length + 1;
    };

    let liveItemsHeight = 0;
    for (const item of liveItems) {
      let itemHeight = 2;

      if (item.kind === "bash_command" || item.kind === "command") {
        itemHeight += countLines(item.input);
        itemHeight += countLines(item.output);
      } else if (item.kind === "tool_call") {
        itemHeight += Math.min(countLines(item.argsText), 5);
        itemHeight += countLines(item.resultText);
      } else if (
        item.kind === "assistant" ||
        item.kind === "reasoning" ||
        item.kind === "error"
      ) {
        itemHeight += countLines(item.text);
      }

      liveItemsHeight += itemHeight;
    }

    const LINES_PER_SUBAGENT = 4;
    const subagentsHeight = subagents.length * LINES_PER_SUBAGENT;

    const FIXED_BUFFER = 20;

    const estimatedHeight = liveItemsHeight + subagentsHeight + FIXED_BUFFER;

    return estimatedHeight;
  }, [liveItems, subagents.length]);

  const [shouldAnimate, setShouldAnimate] = useState(
    () => estimatedLiveHeight < terminalRows,
  );
  useEffect(() => {
    if (terminalRows <= 0) {
      setShouldAnimate(false);
      return;
    }

    const disableThreshold = terminalRows;
    const resumeThreshold = Math.max(
      0,
      terminalRows - ANIMATION_RESUME_HYSTERESIS_ROWS,
    );

    setShouldAnimate((prev) => {
      if (prev) {
        return estimatedLiveHeight < disableThreshold;
      }
      return estimatedLiveHeight < resumeThreshold;
    });
  }, [estimatedLiveHeight, terminalRows]);

  const terminalTitleTaskRunning =
    loadingState !== "ready" ||
    streaming ||
    isExecutingTool ||
    commandRunning ||
    bashRunning ||
    pendingApprovals.length > 0;
  const terminalTitleRunState =
    loadingState !== "ready"
      ? "Starting"
      : !terminalTitleTaskRunning
        ? "Ready"
        : executionPhase === "thinking"
          ? "Thinking"
          : "Working";
  const terminalTitleData = useMemo<WindowTitleData>(
    () => ({
      agentName,
      appName: "Letta Code",
      version: getVersion(),
      conversationSummary,
      conversationId,
      projectDirectory,
      currentDirectory: modContext.workspace.currentDir,
      runState: terminalTitleRunState,
      modelDisplayName: currentModelDisplay,
      reasoningEffort: currentReasoningEffort,
      contextUsedPercentage: modContext.contextWindow.usedPercentage,
      contextRemainingPercentage: modContext.contextWindow.remainingPercentage,
      totalInputTokens: modContext.contextWindow.totalInputTokens,
      totalOutputTokens: modContext.contextWindow.totalOutputTokens,
      fastMode: currentModelServiceTier === CHATGPT_FAST_SERVICE_TIER,
    }),
    [
      agentName,
      conversationId,
      conversationSummary,
      currentModelDisplay,
      currentModelServiceTier,
      currentReasoningEffort,
      modContext.contextWindow.remainingPercentage,
      modContext.contextWindow.totalInputTokens,
      modContext.contextWindow.totalOutputTokens,
      modContext.contextWindow.usedPercentage,
      modContext.workspace.currentDir,
      projectDirectory,
      terminalTitleRunState,
    ],
  );

  useEffect(() => {
    if (
      loadingState === "ready" &&
      !welcomeCommittedRef.current &&
      messageHistory.length === 0
    ) {
      if (!continueSession && !agentProvenance) {
        return;
      }
      welcomeCommittedRef.current = true;
      setStaticItems((prev) => [
        ...prev,
        {
          kind: "welcome",
          id: `welcome-${Date.now().toString(36)}`,
          snapshot: {
            continueSession,
            agentState,
            startupHasAvailableLocalModels,
            terminalWidth: columns,
          },
        },
      ]);

      const statusId = `status-agent-${Date.now().toString(36)}`;

      const isPinned = agentState?.id
        ? settingsManager.isAgentPinned(agentState.id)
        : false;

      const agentName = agentState?.name || "Unnamed Agent";
      const headerMessage = resumedExistingConversation
        ? `Resuming new conversation with **${agentName}**`
        : continueSession
          ? `Starting new conversation with **${agentName}**`
          : "Creating a new agent";

      const commandHints = buildStartupCommandHints({
        isResumingConversation: resumedExistingConversation,
        isPinned,
        isLocalBackend: isLocalBackendEnabled(),
        hasMessages: messageHistory.length > 0,
        hasCloudCredentials: startupHasCloudCredentials,
        hasAvailableLocalModels: startupHasAvailableLocalModels,
      });

      const statusLines: string[] = [];

      const startupSystemPromptWarning =
        buildStartupSystemPromptWarning(agentState);

      if (releaseNotes) {
        statusLines.push(releaseNotes);
        statusLines.push("");
      }

      if (startupSystemPromptWarning) {
        statusLines.push(startupSystemPromptWarning);
      }
      statusLines.push(headerMessage);
      statusLines.push(...commandHints);

      buffersRef.current.byId.set(statusId, {
        kind: "status",
        id: statusId,
        lines: statusLines,
      });
      buffersRef.current.order.push(statusId);
      refreshDerived();
      commitEligibleLines(buffersRef.current, { deferToolCalls: false });
    }
  }, [
    loadingState,
    continueSession,
    resumedExistingConversation,
    messageHistory.length,
    commitEligibleLines,
    columns,
    agentProvenance,
    agentState,
    refreshDerived,
    releaseNotes,
    startupHasCloudCredentials,
    startupHasAvailableLocalModels,
  ]);

  const liveTrajectorySnapshot =
    sessionStatsRef.current.getTrajectorySnapshot();
  const liveTrajectoryTokenBase =
    liveTrajectorySnapshot?.tokens ?? trajectoryTokenBase;
  const liveTrajectoryElapsedBaseMs =
    liveTrajectorySnapshot?.wallMs ?? trajectoryElapsedBaseMs;
  const runTokenDelta = Math.max(
    0,
    tokenCount - trajectoryRunTokenStartRef.current,
  );
  const trajectoryTokenDisplay = Math.max(
    liveTrajectoryTokenBase + runTokenDelta,
    trajectoryTokenDisplayRef.current,
  );
  const inputVisible = !showExitStats;
  const reflectionArenaChoiceVisible = Boolean(
    reflectionArenaChoicePending &&
      !showExitStats &&
      !streaming &&
      !commandRunning &&
      !isExecutingTool &&
      pendingApprovals.length === 0 &&
      !anySelectorOpen,
  );
  const inputEnabled =
    !showExitStats &&
    pendingApprovals.length === 0 &&
    !reflectionArenaChoiceVisible &&
    !anySelectorOpen;
  const onEscapeCommandCancel = useCallback(() => {
    if (isActiveConnectOperationCancellable()) {
      cancelActiveConnectOperation();
      return true;
    }
    return false;
  }, []);
  const showInspirationalPromptHints =
    loadingState === "ready" &&
    !hasConversationContent(lines) &&
    !streaming &&
    queueDisplay.length === 0 &&
    pendingApprovals.length === 0 &&
    !anySelectorOpen;
  const currentApprovalPreviewCommitted = currentApproval?.toolCallId
    ? eagerCommittedPreviewsRef.current.has(currentApproval.toolCallId)
    : false;
  const showApprovalPreview =
    !currentApprovalShouldCommitPreview && !currentApprovalPreviewCommitted;

  useEffect(() => {
    trajectoryTokenDisplayRef.current = trajectoryTokenDisplay;
  }, [trajectoryTokenDisplay]);

  return (
    <>
      <TerminalTitleWriter
        projectDirectory={projectDirectory}
        configRefreshKey={`${activeOverlay ?? ""}:${terminalTitleConfigRefreshEpoch}`}
        titleData={terminalTitleData}
        shouldAnimate={shouldAnimate}
        hasActiveProgress={terminalTitleTaskRunning}
        requiresAction={
          pendingApprovals.length > 0 || reflectionArenaChoiceVisible
        }
        previewTitle={terminalTitlePreviewOverride}
      />
      <AppView
        activeOverlay={activeOverlay}
        agentId={agentId}
        agentName={agentName}
        agentState={agentState}
        anySelectorOpen={anySelectorOpen}
        approvalMap={approvalMap}
        bashRunning={bashRunning}
        billingTier={billingTier}
        btwState={btwState}
        buffersRef={buffersRef}
        chromeColumns={chromeColumns}
        closeOverlay={closeOverlay}
        columns={columns}
        commandRunner={commandRunner}
        completeOverlay={completeOverlay}
        contextTrackerRef={contextTrackerRef}
        continueSession={continueSession}
        conversationId={conversationId}
        conversationSummary={conversationSummary}
        projectDirectory={projectDirectory}
        currentApproval={currentApproval}
        currentApprovalContext={currentApprovalContext}
        currentModelDisplay={currentModelDisplay}
        currentModelHandle={currentModelHandle}
        currentModelId={currentModelId}
        currentModelServiceTier={currentModelServiceTier}
        currentModelProvider={currentModelProvider}
        currentPersonalityId={currentPersonalityId}
        currentReasoningEffort={currentReasoningEffort}
        currentSystemPromptId={currentSystemPromptId}
        currentToolset={currentToolset}
        currentToolsetPreference={currentToolsetPreference}
        expandedToolCallId={expandedToolCallId}
        lastShellToolCallId={lastShellToolCallId}
        handleCtrlO={handleCtrlO}
        queueMode={queueMode}
        deferModeSupported={deferModeSupported}
        handleCtrlD={handleCtrlD}
        emittedIdsRef={emittedIdsRef}
        feedbackPrefill={feedbackPrefill}
        footerUpdateText={footerUpdateText}
        showInspirationalPromptHints={showInspirationalPromptHints}
        onEscapeCommandCancel={onEscapeCommandCancel}
        handleAgentSelect={handleAgentSelect}
        handleApproveAlways={handleApproveAlways}
        handleApproveCurrent={handleApproveCurrent}
        handleBashInterrupt={handleBashInterrupt}
        handleBashSubmit={handleBashSubmit}
        handleBtwJump={handleBtwJump}
        handleCancelApprovals={handleCancelApprovals}
        handleCompactionModeSelect={handleCompactionModeSelect}
        handleCreateNewAgent={handleCreateNewAgent}
        handleCycleReasoningEffort={handleCycleReasoningEffort}
        handleDenyCurrent={handleDenyCurrent}
        handleQueueEdit={handleQueueEdit}
        handleExit={handleExit}
        handleExperimentsConfirm={handleExperimentsConfirm}
        handleFeedbackSubmit={handleFeedbackSubmit}
        handleInterrupt={handleInterrupt}
        handleModelSelect={handleModelSelect}
        handlePasteError={handlePasteError}
        handlePermissionModeChange={handlePermissionModeChange}
        handlePersonalitySelect={handlePersonalitySelect}
        handleProfileEscapeCancel={handleProfileEscapeCancel}
        handleReflectionArenaChoiceCancel={handleReflectionArenaChoiceCancel}
        handleReflectionArenaChoiceSubmit={handleReflectionArenaChoiceSubmit}
        handleSleeptimeModeSelect={handleSleeptimeModeSelect}
        handleSystemPromptSelect={handleSystemPromptSelect}
        handleToolsetSelect={handleToolsetSelect}
        hasBackfilledRef={hasBackfilledRef}
        hasTemporaryModelOverride={hasTemporaryModelOverride}
        includeSystemPromptUpgradeTip={includeSystemPromptUpgradeTip}
        inputEnabled={inputEnabled}
        inputVisible={inputVisible}
        interruptRequested={
          interruptRequested ||
          !!abortControllerRef.current?.signal.aborted ||
          staleTurnUnwindingRef.current
        }
        hasStopFailedTasks={hasStopFailedTasks}
        isAgentBusy={isAgentBusy}
        liveItems={liveItems}
        liveTrajectoryElapsedBaseMs={liveTrajectoryElapsedBaseMs}
        loadingState={loadingState}
        markLocalModelsAvailable={markLocalModelsAvailable}
        maybeCarryOverActiveConversationModel={
          maybeCarryOverActiveConversationModel
        }
        modelReasoningPrompt={modelReasoningPrompt}
        modelSelectorOptions={modelSelectorOptions}
        networkPhase={networkPhase}
        executionPhase={executionPhase}
        fileAutocompleteFdPath={fileAutocompleteFdPath}
        onSubmit={onSubmit}
        pendingApprovals={pendingApprovals}
        pendingConversationSwitchRef={pendingConversationSwitchRef}
        reflectionArenaChoicePending={
          reflectionArenaChoiceVisible ? reflectionArenaChoicePending : null
        }
        pendingIds={pendingIds}
        precomputedDiffsRef={precomputedDiffsRef}
        profileConfirmPending={profileConfirmPending}
        queueDisplay={queueDisplay}
        queuedDecisions={queuedDecisions}
        queuedIds={queuedIds}
        reasoningTabCycleEnabled={reasoningTabCycleEnabled}
        recoverRestoredPendingApprovals={recoverRestoredPendingApprovals}
        refreshDerived={refreshDerived}
        resetBootstrapReminderState={resetBootstrapReminderState}
        resetDeferredToolCallCommits={resetDeferredToolCallCommits}
        resetTrajectoryBases={resetTrajectoryBases}
        restoredInput={restoredInput}
        resumeKey={resumeKey}
        searchQuery={searchQuery}
        sessionStatsRef={sessionStatsRef}
        worktreeDiffSelectorPending={worktreeDiffSelectorPending}
        setWorktreeDiffSelectorPending={setWorktreeDiffSelectorPending}
        setActiveOverlay={setActiveOverlay}
        setBtwState={setBtwState}
        setCommandRunning={setCommandRunning}
        setConversationAutoTitleEligibility={
          setConversationAutoTitleEligibility
        }
        setConversationIdAndRef={setConversationIdAndRef}
        setConversationSummary={setConversationSummary}
        setLines={setLines}
        setModelReasoningPrompt={setModelReasoningPrompt}
        setModelSelectorOptions={setModelSelectorOptions}
        setQueuedOverlayAction={setQueuedOverlayAction}
        setRestoredInput={setRestoredInput}
        setStaticItems={setStaticItems}
        setStaticRenderEpoch={setStaticRenderEpoch}
        shouldAnimate={shouldAnimate}
        showApprovalPreview={showApprovalPreview}
        showCompactionsEnabled={showCompactionsEnabled}
        showExitStats={showExitStats}
        openOverlay={openOverlay}
        staticItems={staticItems}
        staticRenderEpoch={staticRenderEpoch}
        modContext={modContext}
        statusLinePrompt={CLI_GLYPHS.prompt}
        terminalTitleData={terminalTitleData}
        onTitlePreview={setTerminalTitlePreviewOverride}
        onTitlePreviewEnd={clearTerminalTitlePreviewOverride}
        modAdapter={modAdapter}
        streaming={streaming}
        stubDescriptions={stubDescriptions}
        thinkingMessage={thinkingMessage}
        trajectoryTokenDisplay={trajectoryTokenDisplay}
        usedContextTokens={usedContextTokens}
        contextWindowSize={effectiveContextWindowSize}
        uiPermissionMode={uiPermissionMode}
        updateAgentName={updateAgentName}
      />
    </>
  );
}
