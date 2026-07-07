// src/cli/app/AppCoordinator.tsx

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
} from "@/agent/model";
import type { PersonalityId } from "@/agent/personality-presets";
import { shouldRecommendDefaultPrompt } from "@/agent/prompt-assets";
import { reconcileExistingAgentState } from "@/agent/reconcile-existing-agent-state";
import { recordSessionEnd } from "@/agent/session-history";
import { SessionStats } from "@/agent/stats";
import {
  clearSubagentsByIds,
  getActiveBackgroundAgents,
  getSubagentByToolCallId,
  getSnapshot as getSubagentSnapshot,
  subscribe as subscribeToSubagents,
} from "@/agent/subagent-state";
import { getBackend, isLocalBackendEnabled } from "@/backend";
import { getClient } from "@/backend/api/client";
import { getBillingTier } from "@/backend/api/metadata";
import { subscribePiProviderRegistry } from "@/backend/dev/pi-provider-mod-registry";
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
  buildContentFromQueueBatch,
  toQueuedMsg,
} from "@/cli/helpers/queued-message-parts";
import {
  finalizeReflectionArenaChoice,
  formatReflectionArenaDeferredMessage,
  parseReflectionArenaChoiceAnswers,
  type ReflectionArenaChoiceQuestion,
} from "@/cli/helpers/reflection-arena";
import {
  AUTO_REFLECTION_DESCRIPTION,
  launchReflectionSubagent,
  queuePendingReflectionWorktreeReminders,
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
  getTask,
  handleMissedOneShot,
  isProcessAlive,
  readCronFile,
  safeAppendCronRunLogForTask,
  shouldFireTask,
  updateTask,
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
import {
  type MessageQueueItem,
  QueueRuntime,
  type TaskNotificationQueueItem,
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
import { appendTaskNotificationEventsToBuffer } from "@/utils/task-notifications";
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
} from "./model-config";
import { saveLastSessionBeforeExit } from "./session";
import type {
  ActiveOverlay,
  AppProps,
  QueuedOverlayAction,
  StaticItem,
} from "./types";
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
        "→ **/remember**  teach your agent",
      ]
    : isPinned
      ? [
          "→ **/agents**    list all agents",
          "→ **/resume**    resume a previous conversation",
          "→ **/memory**    view your agent's memory",
          "→ **/init**      initialize your agent's memory",
          "→ **/remember**  teach your agent",
        ]
      : [
          "→ **/agents**    list all agents",
          "→ **/resume**    resume a previous conversation",
          "→ **/pin**       save + name your agent",
          "→ **/init**      initialize your agent's memory",
          "→ **/remember**  teach your agent",
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
    onboardingHints.push("→ **/login**     sign in to Constellation");
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
  // Warm the model-access cache in the background so /model is fast on first open.
  useEffect(() => {
    prefetchAvailableModelHandles();
  }, []);

  const [hasAvailableLocalModels, setHasAvailableLocalModels] = useState(
    startupHasAvailableLocalModels,
  );
  const markLocalModelsAvailable = useCallback(() => {
    setHasAvailableLocalModels(true);
  }, []);

  // Track current agent (can change when swapping)
  const [agentId, setAgentId] = useState(initialAgentId);
  const [agentState, setAgentState] = useState(initialAgentState);

  // Helper to update agent name (updates agentState, which is the single source of truth)
  const updateAgentName = useCallback((name: string) => {
    setAgentState((prev) => (prev ? { ...prev, name } : prev));
  }, []);

  // Check if the current agent would benefit from switching to the default prompt.
  // Used to conditionally include the /system tip in streaming tip rotation.
  const includeSystemPromptUpgradeTip = useMemo(() => {
    if (!agentState?.id || !agentState.system) return false;
    const memMode = settingsManager.isMemfsEnabled(agentState.id)
      ? "memfs"
      : ("standard" as const);
    return shouldRecommendDefaultPrompt(agentState.system, memMode);
  }, [agentState]);

  const projectDirectory = process.cwd();

  // Track current conversation (always created fresh on startup)
  const [conversationId, setConversationId] = useState(initialConversationId);
  const [conversationSummary, setConversationSummary] = useState<string | null>(
    null,
  );

  // Keep a ref to the current agentId for use in callbacks that need the latest value
  const agentIdRef = useRef(agentId);
  useEffect(() => {
    agentIdRef.current = agentId;
    telemetry.setCurrentAgentId(agentId);
  }, [agentId]);

  // Keep a ref to the current conversationId for use in callbacks
  const conversationIdRef = useRef(conversationId);
  useEffect(() => {
    conversationIdRef.current = conversationId;
  }, [conversationId]);
  const setConversationIdAndRef = useCallback((nextConversationId: string) => {
    conversationIdRef.current = nextConversationId;
    setConversationId(nextConversationId);
  }, []);

  // Tracks the transcript start index for the current user turn across
  // approval continuations (requires_approval -> approval result round-trip).
  const pendingTranscriptStartLineIndexRef = useRef<number | null>(null);

  // Track the most recent run ID from streaming (for statusline display)
  const lastRunIdRef = useRef<string | null>(null);

  const resumeKey = useSuspend();

  // Pending conversation switch context — consumed on first message after a switch
  const pendingConversationSwitchRef = useRef<
    | import("@/cli/helpers/conversation-switch-alert").ConversationSwitchContext
    | null
  >(null);

  // Track previous prop values to detect actual prop changes (not internal state changes)
  const prevInitialAgentIdRef = useRef(initialAgentId);
  const prevInitialAgentStateRef = useRef(initialAgentState);
  const prevInitialConversationIdRef = useRef(initialConversationId);

  // Sync with prop changes (e.g., when parent updates from "loading" to actual ID)
  // Only sync when the PROP actually changes, not when internal state changes
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

  // Set agent context for tools (especially Task tool)
  useEffect(() => {
    if (agentId) {
      setCurrentAgentId(agentId);
    }
  }, [agentId]);

  // Whether a stream is in flight (disables input)
  // Uses synced state to keep ref in sync for reliable async checks
  const [streaming, setStreaming, streamingRef] = useSyncedState(false);
  const [networkPhase, setNetworkPhase] = useState<
    "upload" | "download" | "error" | null
  >(null);
  const [executionPhase, setExecutionPhase] = useState<ExecutionPhase>(null);
  // Track permission mode changes for UI updates.
  // Keep a ref in sync *synchronously* so async approval classification never
  // reads a stale mode during the render/effect window.
  const [uiPermissionMode, _setUiPermissionMode] = useState(
    permissionMode.getMode(),
  );
  const uiPermissionModeRef = useRef<PermissionMode>(uiPermissionMode);

  // Track which tool call output is expanded (ctrl+o toggles last one)
  const [expandedToolCallId, setExpandedToolCallId] = useState<string | null>(
    null,
  );

  const setUiPermissionMode = useCallback((mode: PermissionMode) => {
    uiPermissionModeRef.current = mode;
    _setUiPermissionMode(mode);

    // Keep the permissionMode singleton in sync *immediately*.
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
  // Separate from streaming state which may be set early for UI responsiveness
  // Tracks depth to allow intentional reentry while blocking parallel calls
  const processingConversationRef = useRef(0);

  // Generation counter - incremented on each ESC interrupt.
  // Allows processConversation to detect if it's been superseded.
  const conversationGenerationRef = useRef(0);

  // Whether an interrupt has been requested for the current stream
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

  // If we have approval requests, we should show the approval dialog instead of the input area
  const [pendingApprovals, setPendingApprovals] = useState<ApprovalRequest[]>(
    [],
  );
  const [approvalContexts, setApprovalContexts] = useState<ApprovalContext[]>(
    [],
  );

  // /btw state - ephemeral pane for forked conversation responses
  const [btwState, setBtwState] = useState<BtwState>({ status: "idle" });

  // Sequential approval: track results as user reviews each approval
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

  // Bash mode state - track running commands for input locking and ESC cancellation
  const [bashRunning, setBashRunning] = useState(false);
  const bashAbortControllerRef = useRef<AbortController | null>(null);

  // Eager approval checking: only enabled when resuming a session (LET-7101)
  // After first successful message, we disable it since any new approvals are from our own turn
  const [needsEagerApprovalCheck, setNeedsEagerApprovalCheck] = useState(
    () => resumedExistingConversation || startupApprovals.length > 0,
  );

  // Track auto-handled results to combine with user decisions
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
  // Prevents interrupt handler from queueing results while approvals are in-flight.
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

  // Bash mode: cache bash commands to prefix next user message
  // Use ref instead of state to avoid stale closure issues in onSubmit
  const bashCommandCacheRef = useRef<Array<{ input: string; output: string }>>(
    [],
  );

  // Derive current approval from pending approvals and results
  // This is the approval currently being shown to the user
  const currentApproval = pendingApprovals[approvalResults.length];
  const currentApprovalContext = approvalContexts[approvalResults.length];
  const activeApprovalId = currentApproval?.toolCallId ?? null;

  // Build Sets/Maps for three approval states (excluding the active one):
  // - pendingIds: undecided approvals (index > approvalResults.length)
  // - queuedIds: decided but not yet executed (index < approvalResults.length)
  // Used to render appropriate stubs while one approval is active
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

    // Helper to compute stub description - called once per approval during memo
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
        // Decided but not yet executed
        queued.add(id);
        const result = approvalResults[i];
        if (result) {
          decisions.set(id, {
            type: result.type,
            reason: result.type === "deny" ? result.reason : undefined,
          });
        }
      } else {
        // Undecided (waiting in queue)
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

  // Overlay/selector state - only one can be open at a time
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
    initialEffort?: ModelReasoningEffort;
    options: Array<{
      effort: ModelReasoningEffort;
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

  // Queued overlay action - executed after end_turn when user makes a selection
  // while agent is busy (streaming/executing tools)
  const [queuedOverlayAction, setQueuedOverlayAction] =
    useState<QueuedOverlayAction>(null);

  // Derived: check if any selector/overlay is open (blocks queue processing and hides input)
  const anySelectorOpen = activeOverlay !== null;

  // Other model/agent state
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
  // Keep state + ref synchronized so async callbacks (e.g. syncAgentState) never
  // read a stale value and accidentally clobber conversation-scoped overrides.
  const [
    hasConversationModelOverride,
    setHasConversationModelOverride,
    hasConversationModelOverrideRef,
  ] = useSyncedState(false);
  const llmConfigRef = useRef(llmConfig);
  useEffect(() => {
    llmConfigRef.current = llmConfig;
  }, [llmConfig]);

  // Cache the conversation's model_settings when a conversation-scoped override is active.
  // On resume, llm_config may omit reasoning_effort even when the conversation model_settings
  // includes it; this snapshot prevents the footer reasoning tag from missing.
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

  // Keep temporary override scoped to the current agent/conversation identity.
  // This uses render-time state adjustment instead of an Effect.
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
  // Full model handle for API calls (e.g., "anthropic/claude-sonnet-4-5-20251101")
  const [currentModelHandle, setCurrentModelHandle] = useState<string | null>(
    null,
  );
  const currentModelHandleRef = useRef(currentModelHandle);
  useEffect(() => {
    currentModelHandleRef.current = currentModelHandle;
  }, [currentModelHandle]);
  // Derive agentName from agentState (single source of truth)
  const agentName = agentState?.name ?? null;
  const [agentDescription, setAgentDescription] = useState<string | null>(null);
  const [agentLastRunAt, setAgentLastRunAt] = useState<string | null>(null);
  // Prefer the currently-active model handle, then fall back to agent.model
  // (canonical handle) and finally llm_config reconstruction.
  const currentModelLabel =
    tempModelOverride ||
    currentModelHandle ||
    agentState?.model ||
    (llmConfig?.model_endpoint_type && llmConfig?.model
      ? `${llmConfig.model_endpoint_type}/${llmConfig.model}`
      : (llmConfig?.model ?? null)) ||
    null;

  // Derive reasoning effort from model_settings (canonical) with llm_config as legacy fallback.
  // When a conversation override is active, the server may still return an agent llm_config
  // with reasoning_effort="none"; prefer the conversation model_settings snapshot.
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

  // Use tier-aware resolution so the display matches the agent's reasoning effort
  // (e.g. "GPT-5.3-Codex" not just "GPT-5" for the first match).
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

  // Billing tier for conditional UI and error context (fetched once on mount)
  const [billingTier, setBillingTier] = useState<string | null>(null);

  // Update error context when model or billing tier changes
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

  // Fetch billing tier once on mount
  useEffect(() => {
    (async () => {
      try {
        const tier = await getBillingTier();
        if (tier) {
          setBillingTier(tier);
        }
      } catch {
        // Silently ignore - billing tier is optional context
      }
    })();
  }, []);

  // Token streaming preference (can be toggled at runtime)
  const [tokenStreamingEnabled, setTokenStreamingEnabled] =
    useState(tokenStreaming);

  // Reasoning tier Tab cycling preference (opt-in only, persisted globally)
  const [reasoningTabCycleEnabled, _setReasoningTabCycleEnabled] = useState(
    initialReasoningTabCycleEnabled,
  );

  // Show compaction messages preference (can be toggled at runtime)
  const [showCompactionsEnabled, _setShowCompactionsEnabled] =
    useState(showCompactions);
  const [terminalTitleConfigRefreshEpoch, setTerminalTitleConfigRefreshEpoch] =
    useState(0);

  // Live, approximate token counter (resets each turn)
  const [tokenCount, setTokenCount] = useState(0);

  // Live total context tokens (history + system + output). Mirrors
  // `contextTrackerRef.current.lastContextTokens` into reactive state so
  // UI can react during streaming — the ref itself doesn't trigger renders.
  const [usedContextTokens, setUsedContextTokens] = useState(0);

  // Trajectory token/time bases (accumulated across runs)
  const [trajectoryTokenBase, setTrajectoryTokenBase] = useState(0);
  const [trajectoryElapsedBaseMs, setTrajectoryElapsedBaseMs] = useState(0);
  const trajectoryRunTokenStartRef = useRef(0);
  const trajectoryTokenDisplayRef = useRef(0);
  const trajectorySegmentStartRef = useRef<number | null>(null);

  // Current thinking message (rotates each turn)
  const [thinkingMessage, setThinkingMessage] = useState(
    getRandomThinkingVerb(),
  );
  const [terminalTitlePreviewOverride, setTerminalTitlePreviewOverride] =
    useState<string | null | undefined>(undefined);
  const clearTerminalTitlePreviewOverride = useCallback(() => {
    setTerminalTitlePreviewOverride(undefined);
  }, []);

  // Session stats tracking
  const sessionStatsRef = useRef(new SessionStats());
  const sessionStartTimeRef = useRef(Date.now());
  const sessionHooksRanRef = useRef(false);
  const sessionModStartAttemptedRef = useRef(false);
  const modAdapterRef = useRef<LocalModAdapter | null>(null);

  // Initialize chunk log for this agent + session (clears buffer, GCs old files).
  // Re-runs when agentId changes (e.g. agent switch via /agents).
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

  // Wire up session stats to telemetry for safety net handlers
  useEffect(() => {
    telemetry.setSessionStatsGetter(() =>
      sessionStatsRef.current.getSnapshot(),
    );

    // Cleanup on unmount (defensive, prevents potential memory leak)
    return () => {
      telemetry.setSessionStatsGetter(undefined);
    };
  }, []);

  // Track trajectory wall time based on streaming state (matches InputRich timer)
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

  // SessionStart hook feedback to prepend to first user message
  const sessionStartFeedbackRef = useRef<string[]>([]);

  // Run SessionStart hooks when agent becomes available (not the "loading" placeholder)
  useEffect(() => {
    if (agentId && agentId !== "loading" && !sessionHooksRanRef.current) {
      sessionHooksRanRef.current = true;
      // Determine if this is a new session or resumed
      const isNewSession = !initialConversationId;
      runSessionStartHooks(
        isNewSession,
        agentId,
        agentName ?? undefined,
        conversationIdRef.current ?? undefined,
      )
        .then((result) => {
          // Store feedback to prepend to first user message
          if (result.feedback.length > 0) {
            sessionStartFeedbackRef.current = result.feedback;
          }
        })
        .catch(() => {
          // Silently ignore hook errors
        });
    }
  }, [agentId, agentName, initialConversationId]);

  // Run SessionEnd hooks helper
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
      } catch {
        // Silently ignore hook errors
      }

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
        } catch {
          // Mod lifecycle events are best-effort on shutdown.
        }
      }
    },
    [],
  );

  // Show exit stats on exit (double Ctrl+C)
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

  // Only brand-new conversations without an explicit title should auto-generate one.
  const shouldAutoGenerateConversationTitleRef = useRef(
    !resumedExistingConversation,
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

    // Heuristic-only when the experiment is off, on local backends, or for
    // the agent-direct "default" conversation (which can't be forked safely).
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
  // Static items (things that are done rendering and can be frozen)
  const [staticItems, setStaticItems] = useState<StaticItem[]>([]);

  // Show in-transcript notification when auto-update applied a significant new version
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
    // Also show briefly in the footer placeholder area
    setFooterUpdateText(
      `New version available (${updateNotification}). Restart to update!`,
    );
    const timer = setTimeout(() => setFooterUpdateText(null), 8000);
    return () => clearTimeout(timer);
  }, [updateNotification]);

  // Track committed ids to avoid duplicates
  const emittedIdsRef = useRef<Set<string>>(new Set());

  // Guard to append welcome snapshot only once
  const welcomeCommittedRef = useRef(false);

  // AbortController for stream cancellation
  const abortControllerRef = useRef<AbortController | null>(null);

  // Track if user wants to cancel (persists across state updates)
  const userCancelledRef = useRef(false);

  // Retry counter for transient LLM API errors (ref for synchronous access in loop)
  const llmApiErrorRetriesRef = useRef(0);
  const quotaAutoSwapAttemptedRef = useRef(false);
  const providerFallbackAttemptedRef = useRef(false);
  const emptyResponseRetriesRef = useRef(0);

  // Retry counter for 409 "conversation busy" errors
  const conversationBusyRetriesRef = useRef(0);

  // Message queue state for queueing messages during streaming
  const [queueDisplay, setQueueDisplay] = useState<QueuedMessage[]>([]);

  // QueueRuntime — authoritative queue. maxItems: Infinity disables drop limits
  // to match the previous unbounded array semantics. queueDisplay is a derived
  // UI state maintained by the onEnqueued/onDequeued/onCleared callbacks.
  // Lazy init pattern; typed QueueRuntime | null with ?. at all call sites.
  const tuiQueueRef = useRef<QueueRuntime | null>(null);
  if (!tuiQueueRef.current) {
    tuiQueueRef.current = new QueueRuntime({
      maxItems: Infinity,
      callbacks: {
        onEnqueued: (item, queueLen) => {
          debugLog(
            "queue-lifecycle",
            `enqueued item_id=${item.id} kind=${item.kind} queue_len=${queueLen}`,
          );
          // queueDisplay is the single source for UI — updated only here.
          if (item.kind === "message" || item.kind === "task_notification") {
            setQueueDisplay((prev) => [...prev, toQueuedMsg(item)]);
          }
        },
        onDequeued: (batch) => {
          debugLog(
            "queue-lifecycle",
            `dequeued batch_id=${batch.batchId} merged_count=${batch.mergedCount} queue_len_after=${batch.queueLenAfter}`,
          );
          // queueDisplay only tracks displayable items. If non-display barrier
          // kinds are ever consumed, avoid over-trimming by counting only
          // message/task_notification entries in the batch.
          const displayConsumedCount = batch.items.filter(
            (item) =>
              item.kind === "message" || item.kind === "task_notification",
          ).length;
          setQueueDisplay((prev) => prev.slice(displayConsumedCount));
        },
        onBlocked: (reason, queueLen) =>
          debugLog(
            "queue-lifecycle",
            `blocked reason=${reason} queue_len=${queueLen}`,
          ),
        onCleared: (_reason, _clearedCount) => {
          debugLog(
            "queue-lifecycle",
            `cleared reason=${_reason} cleared_count=${_clearedCount}`,
          );
          setQueueDisplay([]);
        },
        onRemoved: (item, queueLen) => {
          debugLog(
            "queue-lifecycle",
            `removed item_id=${item.id} kind=${item.kind} queue_len=${queueLen}`,
          );
          // Remove the matching display item by queueItemId
          setQueueDisplay((prev) =>
            prev.filter((msg) => msg.queueItemId !== item.id),
          );
        },
      },
    });
  }

  // Override content parts for queued submissions (to preserve part boundaries)
  const overrideContentPartsRef = useRef<MessageCreate["content"] | null>(null);

  // Set up message queue bridge for background tasks
  // This allows non-React code (Task.ts) to add notifications to queueDisplay
  useEffect(() => {
    // Enqueue via QueueRuntime — onEnqueued callback updates queueDisplay.
    setMessageQueueAdder((message: QueuedMessage) => {
      tuiQueueRef.current?.enqueue(
        message.kind === "task_notification"
          ? ({
              kind: "task_notification",
              source: "task_notification",
              text: message.text,
            } as Parameters<typeof tuiQueueRef.current.enqueue>[0])
          : ({
              kind: "message",
              source: "user",
              content: message.text,
            } as Parameters<typeof tuiQueueRef.current.enqueue>[0]),
      );
      setDequeueEpoch((e) => e + 1);
    });
    return () => setMessageQueueAdder(null);
  }, []);

  // ── Shadow cron scheduler ──────────────────────────────────────────
  // When the tui_cron experiment is enabled, run a lightweight scheduler
  // that fires cron tasks when the desktop app (WS listener) isn't running.
  // The TUI never claims the scheduler lease — it defers to any active
  // lease holder (the desktop app always wins, even old versions).
  // The experiment check is inside tick() so toggling the experiment
  // takes effect without restarting the TUI.
  useEffect(() => {
    if (!agentId || agentId === "loading") return;

    const TICK_INTERVAL_MS = 60_000;
    const firedThisMinute = new Set<string>();
    let lastMinuteKey = "";

    function tick(): void {
      // Check experiment gate on each tick so toggling takes effect immediately
      if (!experimentManager.isEnabled("tui_cron")) return;

      const now = new Date();
      const currentMinuteKey = (() => {
        const d = now;
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
      })();

      // Reset per-minute dedup when minute changes
      if (currentMinuteKey !== lastMinuteKey) {
        firedThisMinute.clear();
        lastMinuteKey = currentMinuteKey;
      }

      // Check if another scheduler (desktop app) is active
      const cronData = readCronFile();
      if (cronData.scheduler_owner) {
        const { pid } = cronData.scheduler_owner;
        if (isProcessAlive(pid, cronData.scheduler_owner)) {
          // Desktop app is running the scheduler — defer
          return;
        }
      }

      // No active scheduler — process tasks for this agent
      const activeTasks = cronData.tasks.filter(
        (t) => t.status === "active" && t.agent_id === agentIdRef.current,
      );

      for (const task of activeTasks) {
        if (firedThisMinute.has(task.id)) continue;

        // Handle missed one-shots
        if (handleMissedOneShot(task, now)) continue;

        if (shouldFireTask(task, now)) {
          firedThisMinute.add(task.id);

          // Apply jitter delay for recurring tasks (same as WS scheduler)
          const jitterMs = task.recurring ? task.jitter_offset_ms : 0;
          const taskId = task.id;
          const doFire = () => {
            // Revalidate: task may have been deleted/cancelled during jitter
            const freshTask = getTask(taskId);
            if (!freshTask || freshTask.status !== "active") return;

            // Format as plain text for the TUI — no <system-reminder> wrapper
            // (the WS scheduler uses wrapCronPrompt with XML, but the TUI
            // renders user messages as-is, so XML shows up raw)
            const text = [
              `Scheduled task "${freshTask.name}" is firing.`,
              freshTask.recurring
                ? `This is fire #${freshTask.fire_count + 1} (cron: ${freshTask.cron}).`
                : `This is a one-off scheduled task.`,
              "",
              freshTask.prompt,
            ].join("\n");
            addToMessageQueue({
              kind: "user",
              text,
              agentId: freshTask.agent_id,
              conversationId: freshTask.conversation_id,
            });

            // Update task state
            const nowIso = new Date().toISOString();
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
              runAtMs: now.getTime(),
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

    // Initial tick
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

  // Cache last sent input - cleared on successful completion, remains if interrupted
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
  // Non-null only when the previous turn was explicitly interrupted by the user.
  // Used to gate recovery alert injection to true user-interrupt retries.
  const pendingInterruptRecoveryConversationIdRef = useRef<string | null>(null);

  // Epoch counter to force dequeue effect re-run when refs change but state doesn't
  // Incremented when userCancelledRef is reset while messages are queued
  const [dequeueEpoch, setDequeueEpoch] = useState(0);
  // Strict lock to ensure dequeue submit path is at-most-once while onSubmit is in flight.
  const dequeueInFlightRef = useRef(false);

  // Queue defer mode: when 'defer', queued messages only fire on end_turn stop reason.
  // Defer mode is only meaningful in API backend mode (local backend fires end_turn
  // between each sequential tool call, making defer indistinguishable from immediate).
  const deferModeSupported = !isLocalAgentId(agentId);
  // When 'immediate' (default), they fire on any turn end.
  const [queueMode, setQueueMode] = useState<"immediate" | "defer">(
    "immediate",
  );
  const handleCtrlD = useCallback(() => {
    if (!deferModeSupported) return;
    setQueueMode((prev) => (prev === "immediate" ? "defer" : "immediate"));
  }, [deferModeSupported]);
  // Ref mirror of queueMode so useConversationLoop can read it without stale closures.
  const queueModeRef = useRef<"immediate" | "defer">("immediate");
  queueModeRef.current = queueMode;
  // Tracks the stop reason of the last completed turn, set by useConversationLoop.
  const lastStopReasonRef = useRef<string | null>(null);

  // Track last dequeued message for restoration on error
  // If an error occurs after dequeue, we restore this to the input field (if input is empty)
  const lastDequeuedMessageRef = useRef<string | null>(null);

  // Restored input value - set when we need to restore a message to the input after error
  const [restoredInput, setRestoredInput] = useState<string | null>(null);

  // Helper to check if agent is busy (streaming, executing tool, or running command)
  // Uses refs for synchronous access outside React's closure system
  // biome-ignore lint/correctness/useExhaustiveDependencies: refs are stable objects, .current is read dynamically
  const isAgentBusy = useCallback(() => {
    return (
      streamingRef.current ||
      isExecutingTool ||
      commandRunningRef.current ||
      abortControllerRef.current !== null
    );
  }, [isExecutingTool]);

  // Ref indirection: refreshDerived is declared later in the component but
  // appendTaskNotificationEvents needs to call it. Using a ref avoids a
  // forward-declaration error while keeping the deps array empty.
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

  // Consume queued messages for appending to tool results (clears queue).
  // consumeItems fires onDequeued → setQueueDisplay(prev => prev.slice(n))
  // so no direct setQueueDisplay call is needed here.
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
      .map(toQueuedMsg);
  }, []);

  // Helper to wrap async handlers that need to close overlay and lock input
  // Closes overlay and sets commandRunning before executing, releases lock in finally
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

  // Track terminal dimensions for layout and overflow detection
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
  // Keep bottom chrome from ever exceeding the *actual* terminal width.
  // When widening, we prefer the old behavior (wait until settle), so we use
  // stableColumns. When shrinking, we must clamp to rawColumns to avoid Ink
  // wrapping the footer/input chrome and "printing" divider rows into the
  // transcript while dragging.
  const chromeColumns = Math.min(rawColumns, stableColumns);
  const debugFlicker = process.env.LETTA_DEBUG_FLICKER === "1";

  // Terminal resize + Ink:
  // When the terminal shrinks, the *previous* frame reflows (wraps to more
  // lines) instantly at the emulator level. Ink's incremental redraw then tries
  // to clear based on the old line count and can leave stale rows behind.
  //
  // Fix: on shrink events, clear the screen *synchronously* in the resize event
  // handler (before React/Ink flushes the next frame) and remount Static output.
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

      // Skip initial mount.
      if (isInitialResizeRef.current) {
        return;
      }

      const shrunk = nextColumns < prevColumns || nextRows < prevRows;
      if (!shrunk) {
        // Reset shrink-clear guard once the gesture ends.
        if (resizeGestureTimeoutRef.current) {
          clearTimeout(resizeGestureTimeoutRef.current);
        }
        resizeGestureTimeoutRef.current = setTimeout(() => {
          resizeGestureTimeoutRef.current = null;
          didImmediateShrinkClearRef.current = false;
        }, RESIZE_SETTLE_MS);
        return;
      }

      // During a shrink gesture, do an immediate clear only once.
      // Clearing on every resize event causes extreme flicker.
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

      // Cancel any debounced clear; we're taking the immediate-clear path.
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

        // If resize changed again while waiting, let the latest schedule win.
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

    // Clear pending debounced operation on any resize
    if (resizeClearTimeout.current) {
      clearTimeout(resizeClearTimeout.current);
      resizeClearTimeout.current = null;
    }

    // Skip initial mount - no clearing needed on first render
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
      // Defer clear/remount until streaming ends to avoid Ghostty flicker.
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

    // Debounce to avoid flicker from rapid resize events (e.g., drag resize, Ghostty focus)
    // and keep clear frequency bounded to prevent flash storms.
    scheduleResizeClear(rawColumns);

    prevColumnsRef.current = rawColumns;
  }, [rawColumns, streaming, scheduleResizeClear]);

  // Reflow Static output for 1-col width changes too.
  // rawColumns resize handling intentionally ignores 1-col "jitter" to reduce
  // flicker, but that also means widening by small increments won't remount
  // Static and existing output won't reflow.
  //
  // stableColumns only advances once the width has settled, so it's safe to use
  // for a low-frequency remount trigger.
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

  // Commit immutable/finished lines into the historical log
  const commitEligibleLines = useCallback(
    (b: Buffers, opts?: { deferToolCalls?: boolean }) => {
      const deferToolCalls = opts?.deferToolCalls !== false;
      const newlyCommitted: StaticItem[] = [];
      let firstTaskIndex = -1;
      const deferredCommits = deferredToolCallCommitsRef.current;
      const now = Date.now();
      let blockedByDeferred = false;
      // If we eagerly committed a tall preview for file tools, don't also
      // commit the successful tool_call line (preview already represents it).
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
        // Skip deferral when the result is already available: the component height
        // has already changed (header + result), so deferring only extends the
        // live-area repaint window that causes ghost lines in the terminal scrollback.
        return ln.resultText != null;
      };
      if (!deferToolCalls && deferredCommits.size > 0) {
        deferredCommits.clear();
        setDeferredCommitAt(null);
      }

      // Check if there are any in-progress Task tool_calls
      const hasInProgress = hasInProgressTaskToolCalls(
        b.order,
        b.byId,
        emittedIdsRef.current,
      );

      // Collect finished Task tool_calls for grouping
      const finishedTaskToolCalls = collectFinishedTaskToolCalls(
        b.order,
        b.byId,
        emittedIdsRef.current,
        hasInProgress,
      );

      // Commit regular lines (non-Task tools)
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
        // Events only commit when finished (they have running/finished phases)
        if (ln.kind === "event" && ln.phase === "finished") {
          emittedIdsRef.current.add(id);
          newlyCommitted.push({ ...ln });
          continue;
        }
        // Commands with phase should only commit when finished
        if (ln.kind === "command" || ln.kind === "bash_command") {
          if (!ln.phase || ln.phase === "finished") {
            emittedIdsRef.current.add(id);
            newlyCommitted.push({ ...ln });
          }
          continue;
        }
        // Handle Task tool_calls specially - track position but don't add individually
        // (unless there's no subagent data, in which case commit as regular tool call)
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
          // Check if this specific Task tool has subagent data (will be grouped)
          const hasSubagentData = finishedTaskToolCalls.some(
            (tc) => tc.lineId === id,
          );
          if (hasSubagentData) {
            // Has subagent data - will be grouped later
            if (firstTaskIndex === -1) {
              firstTaskIndex = newlyCommitted.length;
            }
            continue;
          }
          // No subagent data (e.g., backfilled from history) - commit as regular tool call
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
          // Note: We intentionally don't cleanup precomputedDiffs here because
          // the Static area renders AFTER this function returns (on next React tick),
          // and the diff needs to be available for ToolCallMessage to render.
          // The diffs will be cleaned up when the session ends or on next session start.
        }
      }

      // If we collected Task tool_calls (all are finished), create a subagent_group
      if (!blockedByDeferred && finishedTaskToolCalls.length > 0) {
        // Mark all as emitted
        for (const tc of finishedTaskToolCalls) {
          emittedIdsRef.current.add(tc.lineId);
        }

        const groupItem = createSubagentGroupItem(finishedTaskToolCalls);

        // Insert at the position of the first Task tool_call
        newlyCommitted.splice(
          firstTaskIndex >= 0 ? firstTaskIndex : newlyCommitted.length,
          0,
          groupItem,
        );

        // Clear these agents from the subagent store
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

  // Render-ready transcript
  const [lines, setLines] = useState<Line[]>([]);

  // Canonical buffers stored in a ref (mutated by onChunk), PERSISTED for session
  const buffersRef = useRef(createBuffers());

  // Context-window token tracking, decoupled from streaming buffers
  const contextTrackerRef = useRef(createContextTracker());

  // Track whether we've already backfilled history (should only happen once)
  const hasBackfilledRef = useRef(false);

  // Keep buffers in sync with tokenStreamingEnabled state for aggressive static promotion
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

  // Keep buffers in sync with agentId for server-side tool hooks
  useEffect(() => {
    buffersRef.current.agentId = agentState?.id;
  }, [agentState?.id]);

  // Cache precomputed diffs from approval dialogs for tool return rendering
  // Key: toolCallId or "toolCallId:filePath" for Patch operations
  const precomputedDiffsRef = useRef<Map<string, AdvancedDiffSuccess>>(
    new Map(),
  );

  // Track which approval tool call IDs have had their previews eagerly committed
  // This prevents double-committing when the approval changes
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
        } else if (t === "shell") {
          const cmdVal = args.command;
          command = Array.isArray(cmdVal)
            ? cmdVal.join(" ")
            : typeof cmdVal === "string"
              ? cmdVal
              : "(no command)";
          description =
            typeof args.justification === "string" ? args.justification : "";
        } else {
          command =
            typeof args.command === "string" ? args.command : "(no command)";
          description =
            typeof args.description === "string"
              ? args.description
              : typeof args.justification === "string"
                ? args.justification
                : "";
        }

        let lines = 3; // solid line + header + blank line
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
        const headerLines = 4; // solid line + header + dotted lines
        let diffLines = 0;
        const toolCallId = approval.toolCallId;

        if (isPatchTool(toolName) && typeof args.input === "string") {
          const operations = parsePatchOperations(args.input);
          operations.forEach((op, idx) => {
            if (idx > 0) diffLines += 1; // blank line between operations
            diffLines += 1; // filename line

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

            diffLines += 1; // delete placeholder
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

        if (Array.isArray(args.edits)) {
          for (const edit of args.edits) {
            if (!edit || typeof edit !== "object") continue;
            const oldString =
              typeof edit.old_string === "string" ? edit.old_string : "";
            const newString =
              typeof edit.new_string === "string" ? edit.new_string : "";
            diffLines += countWrappedLines(oldString, wrapWidth);
            diffLines += countWrappedLines(newString, wrapWidth);
          }
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

  // Recompute UI state from buffers after each streaming chunk
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
    // Redact secret values so they don't leak into agent context
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

  // Combines startOverlayCommand + setActiveOverlay — these are always called together.
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

  // Combines consumeOverlayCommand + the UI-reset side of closeOverlay, but WITHOUT
  // calling cmd.finish(dismissOutput). Use this when the overlay completed successfully
  // and the caller will finish the command with a real result. Contrast with
  // closeOverlay() (cancel path) which does finish with the dismiss message.
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

  // Trailing-edge debounce for bash streaming output (100ms = max 10 updates/sec)
  // Unlike refreshDerivedThrottled, this REPLACES pending updates to always show latest state
  const streamingRefreshTimeoutRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const refreshDerivedStreaming = useCallback(() => {
    // Cancel any pending refresh - we want the LATEST state
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

  // Cleanup streaming refresh on unmount
  useEffect(() => {
    return () => {
      if (streamingRefreshTimeoutRef.current) {
        clearTimeout(streamingRefreshTimeoutRef.current);
      }
    };
  }, []);

  // Helper to update streaming output for bash/shell tools
  const updateStreamingOutput = useCallback(
    (toolCallId: string, chunk: string, isStderr = false) => {
      recordTuiPerf(`tool_output:${isStderr ? "stderr" : "stdout"}`, {
        bytes: Buffer.byteLength(chunk),
      });

      const lineId = buffersRef.current.toolCallIdToLineId.get(toolCallId);
      if (!lineId) return;

      const entry = buffersRef.current.byId.get(lineId);
      if (!entry || entry.kind !== "tool_call") return;

      // Immutable update with tail buffer
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

  // Throttled version for streaming updates (~60fps max)
  const refreshDerivedThrottled = useCallback(() => {
    // Use a ref to track pending refresh
    if (!buffersRef.current.pendingRefresh) {
      buffersRef.current.pendingRefresh = true;
      // Capture the current generation to detect if resume invalidates this refresh
      const capturedGeneration = buffersRef.current.commitGeneration || 0;
      setTimeout(() => {
        buffersRef.current.pendingRefresh = false;
        // Skip refresh if stream was interrupted - prevents stale updates appearing
        // after user cancels. Normal stream completion still renders (interrupted=false).
        // Also skip if commitGeneration changed - this means a resume is in progress and
        // committing now would lock in the stale "Interrupted by user" state.
        if (
          !buffersRef.current.interrupted &&
          (buffersRef.current.commitGeneration || 0) === capturedGeneration
        ) {
          recordTuiPerf("ui_refresh:stream");
          refreshDerived();
        }
      }, 16); // ~60fps
    }
  }, [refreshDerived]);

  // Eager commit for large approval previews (bash/file edits) to avoid flicker
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

  // Backfill message history when resuming (only once). Use layout timing so
  // the ready input is not painted before the resumed transcript.
  useLayoutEffect(() => {
    if (
      loadingState === "ready" &&
      messageHistory.length > 0 &&
      !hasBackfilledRef.current
    ) {
      // Set flag FIRST to prevent double-execution in strict mode
      hasBackfilledRef.current = true;
      // Append welcome snapshot FIRST so it appears above history
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
      // Use backfillBuffers to properly populate the transcript from history
      backfillBuffers(buffersRef.current, messageHistory);

      // Add combined status at the END so user sees it without scrolling
      const statusId = `status-resumed-${Date.now().toString(36)}`;

      // Check if agent is pinned
      const isPinned = agentState?.id
        ? settingsManager.isAgentPinned(agentState.id)
        : false;

      // Build status message
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

      // Build status lines with optional release notes above header
      const statusLines: string[] = [];

      const startupSystemPromptWarning =
        buildStartupSystemPromptWarning(agentState);

      // Add release notes first (above everything) - same styling as rest of status block
      if (releaseNotes) {
        statusLines.push(releaseNotes);
        statusLines.push(""); // blank line separator
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

  // Fetch llmConfig when agent is ready
  useEffect(() => {
    if (loadingState === "ready" && agentId && agentId !== "loading") {
      let cancelled = false;

      const fetchConfig = async () => {
        try {
          // Use pre-loaded agent state if available, otherwise fetch
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

          // Infer the system prompt id for footer/selector display by matching the
          // stored agent.system content against our known prompt presets.
          try {
            const agentSystem = (agent as { system?: unknown }).system;
            if (typeof agentSystem === "string") {
              const normalize = (s: string) => {
                // Match prompt presets even if a managed memory section is present.
                const withoutMemfs = s.replace(/\n# Memory[\s\S]*$/, "");
                return withoutMemfs.replace(/\r\n/g, "\n").trim();
              };
              const sysNorm = normalize(agentSystem);
              const { SYSTEM_PROMPTS, SYSTEM_PROMPT } = await import(
                "@/agent/prompt-assets"
              );

              // Best-effort preset detection.
              // Exact match is ideal, but allow prefix-matches because the stored
              // agent.system may have additional sections appended.
              let matched: string | null = null;

              const contentMatches = (content: string): boolean => {
                const norm = normalize(content);
                return (
                  norm === sysNorm ||
                  (norm.length > 0 &&
                    (sysNorm.startsWith(norm) || norm.startsWith(sysNorm)))
                );
              };

              const promptMatches = (prompt: {
                content: string;
                memfsContent?: string;
              }): boolean =>
                contentMatches(prompt.content) ||
                (prompt.memfsContent
                  ? contentMatches(prompt.memfsContent)
                  : false);

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
                  // SYSTEM_PROMPT is used when no preset was specified.
                  // Display as default since it maps to the default selector option.
                  matched = "default";
                }
              }

              setCurrentSystemPromptId(matched ?? "custom");
            } else {
              setCurrentSystemPromptId("custom");
            }
          } catch {
            // best-effort only
            setCurrentSystemPromptId("custom");
          }
          // Get last message timestamp from agent state if available
          const lastRunCompletion = (
            agent as {
              last_run_completion?: string;
            }
          ).last_run_completion;
          setAgentLastRunAt(lastRunCompletion ?? null);

          // Derive model ID from the configured model handle for ModelSelector.
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
          // Store full handle for API calls (e.g., compaction)
          setCurrentModelHandle(agentModelHandle || null);

          const persistedToolsetPreference =
            settingsManager.getToolsetPreference(agentId);
          setCurrentToolsetPreference(persistedToolsetPreference);

          if (persistedToolsetPreference === "auto") {
            if (agentModelHandle) {
              const { switchToolsetForModel } = await import("@/tools/toolset");
              const providerType =
                providerTypeFromModelSettings(agent.model_settings) ??
                agent.llm_config?.model_endpoint_type ??
                null;
              const derivedToolset = await switchToolsetForModel(
                agentModelHandle,
                agentId,
                providerType,
              );
              setCurrentToolset(derivedToolset);
            } else {
              setCurrentToolset(null);
            }
          } else {
            const { forceToolsetSwitch } = await import("@/tools/toolset");
            await forceToolsetSwitch(persistedToolsetPreference, agentId);
            setCurrentToolset(persistedToolsetPreference);
          }

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

  // Mod provider metadata can arrive after the first local AgentState
  // projection on cold boot. Re-project the active local agent when the provider
  // registry changes so statusline context windows reflect registered models.
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

  // Keep effective model state in sync with the active conversation override.
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

    const applyAgentModelLocally = () => {
      const agentModelHandle = getPreferredAgentModelHandle(agentState);
      setHasConversationModelOverride(false);
      setConversationOverrideModelSettings(null);
      setConversationOverrideContextWindowLimit(null);
      setLlmConfig(agentState.llm_config);
      setCurrentModelHandle(agentModelHandle ?? null);

      // If the model handle hasn't changed, skip re-deriving the model ID.
      // The current ID (set by handleModelSelect or a prior derivation) is
      // already correct. Re-deriving is lossy for variants that share a
      // handle but differ only by context_window (e.g. 1M vs 200k).
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
      // "default" is a virtual sentinel for the agent's primary message history,
      // not a real conversation object — skip the API call.
      // If the user just switched models via /model, honour the local override
      // until the next agent state refresh brings back the updated model.
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
        const resolvedConversationModelSettings = hasConversationModelSettings
          ? conversationModelSettings
          : conversationModel === undefined ||
              conversationModel === null ||
              conversationModel === agentModelHandle
            ? (agentState.model_settings ?? null)
            : null;

        const reasoningEffort = deriveReasoningEffort(
          resolvedConversationModelSettings,
          agentState.llm_config,
        );
        const conversationServiceTier =
          (
            resolvedConversationModelSettings as
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
        setConversationOverrideModelSettings(resolvedConversationModelSettings);
        setConversationOverrideContextWindowLimit(
          resolvedConversationContextWindowLimit,
        );
        setCurrentModelHandle(effectiveModelHandle);
        setCurrentModelId(modelInfo?.id ?? effectiveModelHandle);
        setLlmConfig({
          ...agentState.llm_config,
          ...mapHandleToLlmConfigPatch(
            effectiveModelHandle,
            providerTypeFromModelSettings(resolvedConversationModelSettings),
          ),
          ...(typeof reasoningEffort === "string"
            ? { reasoning_effort: reasoningEffort }
            : {}),
          ...(typeof resolvedConversationContextWindowLimit === "number"
            ? { context_window: resolvedConversationContextWindowLimit }
            : {}),
        } as LlmConfig);
      } catch (error) {
        if (cancelled) return;
        debugLog(
          "conversation-model",
          "Failed to sync conversation model override: %O",
          error,
        );
        // Preserve current local state on transient errors — the override flag
        // was set by a successful /model write and should not be cleared by a
        // failed read. The next sync cycle will retry and self-correct.
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
      if (!hasConversationModelOverrideRef.current) {
        return;
      }

      const currentLlmConfig = llmConfigRef.current;
      const rawModelHandle = buildModelHandleFromLlmConfig(currentLlmConfig);
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
          { avoidOverwritingExistingContextWindow: true },
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

  // Helper to append an error to the transcript
  // Also tracks the error in telemetry so we know an error was shown.
  // Pass `true` or `{ skip: true }` to suppress telemetry (e.g. hint
  // lines that follow an already-tracked primary error).
  // Pass an options object with errorType / context / etc. to enrich the
  // telemetry event beyond the default "ui_error" / "error_display".
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
      // Defensive: ensure message is always a string (guards against [object Object])
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

      // Track error in telemetry (unless explicitly skipped)
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
      keepRunning = false, // If true, keep phase as "running" (for conflict dialogs)
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
    // Only run startup sync if memfs is enabled for this agent
    if (!settingsManager.isMemfsEnabled(agentId)) {
      return;
    }

    memoryFilesystemInitializedRef.current = true;

    // Git-backed memory: API-backed MemFS clones/pulls from the Letta remote.
    // Local backend MemFS is already a local git repo under the local backend
    // store, so startup only needs to ensure the repo exists.
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
        // Warn user visually
        appendError(`Memory git sync failed: ${errMsg}`);
        // Inject reminder so the agent also knows memory isn't synced
        pendingGitReminderRef.current = {
          dirty: false,
          aheadOfRemote: false,
          summary: `Git memory sync failed on startup: ${errMsg}\nMemory may be stale. Try running: git -C ${getScopedMemoryFilesystemRoot(agentId)} pull`,
        };
      }
    })();
  }, [agentId, agentName, loadingState, appendError]);

  // Set up fs.watch on the memory directory to detect external file edits.
  // When a change is detected, set a dirty flag — the actual conflict check
  // runs on the next turn (debounced, non-blocking).
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

        watcher = watch(memRoot, { recursive: true }, () => {
          // Git-backed memory: no auto-sync on file changes.
          // Agent handles commit/push. Status checked on interval.
        });
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

  // Note: Old memFS conflict resolution overlay (handleMemorySyncConflictSubmit/Cancel)
  // removed. Git-backed memory uses standard git merge conflict resolution via the agent.

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
        onCompaction: () =>
          queuePendingReflectionWorktreeReminders({
            agentId: reflectionAgentId,
            conversationId: conversationIdRef.current ?? "default",
          }),
        launch: async (triggerSource) => {
          const result = await launchReflectionSubagent({
            agentId: reflectionAgentId,
            conversationId: conversationIdRef.current ?? "default",
            memfsEnabled: isActiveMemfsEnabled(reflectionAgentId),
            triggerSource,
            skipPendingWorktreeReminderScan:
              triggerSource === "compaction-event",
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
              model: currentModelId,
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
  }, [
    agentName,
    agentDescription,
    currentModelId,
    appendTaskNotificationEvents,
  ]);

  const processConversation = useConversationLoop({
    abortControllerRef,
    agentIdRef,
    appendError,
    appendTaskNotificationEvents,
    approvalToolContextIdRef,
    autoAllowedExecutionRef,
    buffersRef,
    clearApprovalToolContext,
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
    providerFallbackAttemptedRef,
    queueApprovalResults,
    queueSnapshotRef,
    quotaAutoSwapAttemptedRef,
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
    handleQuestionSubmit,
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
    saveLastSessionBeforeExit(conversationIdRef.current);

    // Run SessionEnd hooks
    await runEndHooks();

    // Track session end explicitly (before exit) with stats
    const stats = sessionStatsRef.current.getSnapshot();
    telemetry.trackSessionEnd(stats, "exit_command");

    // Record session to local history file
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
    } catch {
      // Non-critical, don't fail the exit
    }

    // Flush telemetry before exit
    await telemetry.flush();

    setShowExitStats(true);
    // Give React time to render the stats, then exit
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

  // Queue edit: load all queued user messages into the input (joined with newlines),
  // then clear them from the queue so the user can edit and re-submit as one message.
  const handleQueueEdit = useCallback((): string => {
    const userMessages = queueDisplay.filter((m) => m.kind === "user");
    if (userMessages.length === 0) return "";

    // Try to remove each message from the runtime queue. Only include text
    // from messages that were actually removed — if removeItem returns null,
    // the item was already dequeued (race with auto-send) and should NOT be
    // loaded into the input (it would cause a double-send).
    const removedTexts: string[] = [];
    for (const msg of userMessages) {
      if (msg.queueItemId) {
        const removed = tuiQueueRef.current?.removeItem(msg.queueItemId);
        if (removed) {
          removedTexts.push(msg.text);
        }
        // If removed is null, item was already dequeued/sent — skip it
      } else {
        // No queueItemId (shouldn't happen for user messages), include anyway
        removedTexts.push(msg.text);
      }
    }

    if (removedTexts.length === 0) return ""; // All already dequeued/sent

    // Clear display immediately — same render cycle as the input update
    setQueueDisplay((prev) => prev.filter((m) => m.kind !== "user"));

    return removedTexts.join("\n");
  }, [queueDisplay]);

  // Handle paste errors (e.g., image too large)
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
    queueApprovalResults,
    refreshDerived,
    resetTrajectoryBases,
    setApprovalContexts,
    setApprovalResults,
    setAutoDeniedApprovals,
    setAutoHandledResults,
    setInterruptRequested,
    setIsExecutingTool,
    setPendingApprovals,
    setRestoreQueueOnCancel,
    setStreaming,
    streaming,
    toolAbortControllerRef,
    toolResultsInFlightRef,
    userCancelledRef,
    waitingForQueueCancelRef,
  });

  // Keep ref to latest processConversation to avoid circular deps in useEffect
  const processConversationRef = useRef(processConversation);
  useEffect(() => {
    processConversationRef.current = processConversation;
  }, [processConversation]);

  // Reasoning tier cycling state shared by /model, /agents, and tab-cycling flows.
  const reasoningCycleDebounceMs = 500;
  const reasoningCycleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const reasoningCycleInFlightRef = useRef(false);
  const reasoningCycleDesiredRef = useRef<{
    modelHandle: string;
    effort: string;
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
        if (answer.action === "defer") {
          appendTaskNotificationEvents([
            formatReflectionArenaDeferredMessage(pending.runId),
          ]);
          return;
        }
        const { message } = await finalizeReflectionArenaChoice({
          runId: pending.runId,
          choice: answer.choice,
          notes: answer.notes,
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

  // Process queued messages when streaming ends.
  // QueueRuntime is authoritative: consumeItems drives the dequeue and fires
  // onDequeued → setQueueDisplay(prev => prev.slice(n)) to update the UI.
  // dequeueEpoch is the sole re-trigger: bumped on every enqueue, turn
  // completion (abortControllerRef clears), and cancel-reset.
  useEffect(() => {
    void dequeueEpoch; // explicit dep to satisfy exhaustive-deps lint

    const queueLen = tuiQueueRef.current?.length ?? 0;
    const hasAnythingQueued = queueLen > 0;

    if (
      !streaming &&
      hasAnythingQueued &&
      !queuedOverlayAction && // Prioritize queued model/toolset/system switches before dequeuing messages
      pendingApprovals.length === 0 &&
      !commandRunning &&
      !isExecutingTool &&
      !reflectionArenaChoicePending &&
      !anySelectorOpen && // Don't dequeue while a selector/overlay is open
      !waitingForQueueCancelRef.current && // Don't dequeue while waiting for cancel
      !userCancelledRef.current && // Don't dequeue if user just cancelled
      !abortControllerRef.current && // Don't dequeue while processConversation is still active
      !dequeueInFlightRef.current && // Don't dequeue while previous dequeue submit is still in flight
      // In defer mode, only dequeue when the agent is truly done:
      // - last stop reason was end_turn (not requires_approval or error)
      // - processingConversationRef === 0 (no nested processConversation calls outstanding)
      (queueMode === "immediate" ||
        (lastStopReasonRef.current === "end_turn" &&
          processingConversationRef.current === 0))
    ) {
      // consumeItems(n) fires onDequeued → setQueueDisplay(prev => prev.slice(n)).
      const batch = tuiQueueRef.current?.consumeItems(queueLen);
      if (!batch) return;

      // Build concatenated text for lastDequeuedMessageRef (error restoration).
      const concatenatedMessage = batch.items
        .map((item) => {
          if (item.kind === "task_notification") return item.text;
          if (item.kind === "message") {
            return typeof item.content === "string" ? item.content : "";
          }
          return "";
        })
        .filter((t) => t.length > 0)
        .join("\n");

      const queuedContentParts = buildContentFromQueueBatch(batch);

      debugLog(
        "queue",
        `Dequeuing ${batch.mergedCount} message(s): "${concatenatedMessage.slice(0, 50)}${concatenatedMessage.length > 50 ? "..." : ""}"`,
      );

      // Store before submit — allows restoration on error (ESC path).
      lastDequeuedMessageRef.current = concatenatedMessage;

      // Submit via normal flow — overrideContentPartsRef carries rich content parts.
      overrideContentPartsRef.current = queuedContentParts;
      // Lock prevents re-entrant dequeue if deps churn before processConversation
      // sets abortControllerRef (which is the normal long-term gate).
      dequeueInFlightRef.current = true;
      // Reset to immediate mode after each dequeue — defer is opt-in per batch.
      setQueueMode("immediate");
      void onSubmitRef.current(concatenatedMessage).finally(() => {
        dequeueInFlightRef.current = false;
        // If more items arrived while in-flight, bump epoch so the effect re-runs.
        if ((tuiQueueRef.current?.length ?? 0) > 0) {
          setDequeueEpoch((e) => e + 1);
        }
      });
    } else if (hasAnythingQueued) {
      // Log why dequeue was blocked (useful for debugging stuck queues)
      debugLog(
        "queue",
        `Dequeue blocked: streaming=${streaming}, queuedOverlayAction=${!!queuedOverlayAction}, pendingApprovals=${pendingApprovals.length}, commandRunning=${commandRunning}, isExecutingTool=${isExecutingTool}, anySelectorOpen=${anySelectorOpen}, waitingForQueueCancel=${waitingForQueueCancelRef.current}, userCancelled=${userCancelledRef.current}, abortController=${!!abortControllerRef.current}`,
      );
      // Emit queue_blocked on blocked-reason transitions only (dedup via tryDequeue).
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

  // Process queued overlay actions when streaming ends
  // These are actions from interactive commands (like /agents, /model) that were
  // used while the agent was busy. The change is applied after end_turn.
  useEffect(() => {
    if (
      !streaming &&
      !commandRunning &&
      !isExecutingTool &&
      pendingApprovals.length === 0 &&
      queuedOverlayAction !== null
    ) {
      const action = queuedOverlayAction;
      setQueuedOverlayAction(null); // Clear immediately to prevent re-runs

      // Process the queued action
      if (action.type === "switch_agent") {
        // Call handleAgentSelect - it will see isAgentBusy() as false now
        handleAgentSelect(action.agentId, {
          commandId: action.commandId,
          backendMode: action.backendMode,
        });
      } else if (action.type === "switch_model") {
        // Call handleModelSelect - it will see isAgentBusy() as false now
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

        // Execute the conversation switch asynchronously
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

                // Reset context tokens for new conversation
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

  // Handle escape when profile confirmation is pending
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

  // Toggle expand/collapse for a specific tool call ID
  const handleToggleExpandedToolCall = useCallback((id: string) => {
    setExpandedToolCallId((prev) => (prev === id ? null : id));
  }, []);

  // The ID of the last finished shell tool call — used for the ctrl+o hint and handler.
  // lines is intentionally in the dep array to recompute when buffers change (buffersRef is a ref).
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

  // ctrl+o toggles the last shell tool call output
  const handleCtrlO = useCallback(() => {
    if (lastShellToolCallId) {
      handleToggleExpandedToolCall(lastShellToolCallId);
    }
  }, [lastShellToolCallId, handleToggleExpandedToolCall]);

  // Handle permission mode changes from the Input component (e.g., shift+tab cycling)
  const handlePermissionModeChange = useCallback(
    (mode: PermissionMode) => {
      // permissionMode.setMode() is called in InputRich.tsx before this callback
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

  // Live area shows only in-progress items
  // biome-ignore lint/correctness/useExhaustiveDependencies: staticItems.length and deferredCommitAt are intentional triggers to recompute when items are promoted to static or deferred commits complete
  const liveItems = useMemo(() => {
    return lines.filter((ln) => {
      if (!("phase" in ln)) return false;
      if (emittedIdsRef.current.has(ln.id)) return false;
      if (ln.kind === "command" || ln.kind === "bash_command") {
        return ln.phase === "running";
      }
      if (ln.kind === "tool_call") {
        // Task tool_calls need special handling:
        // - Only include if pending approval (phase: "ready" or "streaming")
        // - Running/finished Task tools are handled by SubagentGroupDisplay
        if (ln.name && isTaskTool(ln.name)) {
          // Only show Task tools that are awaiting approval (not running/finished)
          return ln.phase === "ready" || ln.phase === "streaming";
        }
        // Always show other tool calls in progress
        return (
          ln.phase !== "finished" ||
          deferredToolCallCommitsRef.current.has(ln.id)
        );
      }
      // Events (like compaction) show while running
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

  // Subscribe to subagent state for reactive overflow detection
  const { agents: subagents } = useSyncExternalStore(
    subscribeToSubagents,
    getSubagentSnapshot,
  );

  // Estimate live area height for overflow detection.
  const estimatedLiveHeight = useMemo(() => {
    // Count actual lines in live content by counting newlines
    const countLines = (text: string | undefined): number => {
      if (!text) return 0;
      return (text.match(/\n/g) || []).length + 1;
    };

    // Estimate height for each live item based on actual content
    let liveItemsHeight = 0;
    for (const item of liveItems) {
      // Base height for each item (header line, margins)
      let itemHeight = 2;

      if (item.kind === "bash_command" || item.kind === "command") {
        // Count lines in command input and output
        itemHeight += countLines(item.input);
        itemHeight += countLines(item.output);
      } else if (item.kind === "tool_call") {
        // Count lines in tool args and result
        itemHeight += Math.min(countLines(item.argsText), 5); // Cap args display
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

    // Subagents: 4 lines each (description + URL + status + margin)
    const LINES_PER_SUBAGENT = 4;
    const subagentsHeight = subagents.length * LINES_PER_SUBAGENT;

    // Fixed buffer for header, input area, status bar, margins
    // Using larger buffer to catch edge cases and account for timing lag
    const FIXED_BUFFER = 20;

    const estimatedHeight = liveItemsHeight + subagentsHeight + FIXED_BUFFER;

    return estimatedHeight;
  }, [liveItems, subagents.length]);

  // Overflow detection with hysteresis: disable quickly on overflow, re-enable
  // only after we've recovered extra headroom to avoid flap near the boundary.
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

  // Commit welcome snapshot once when ready for fresh sessions (no history)
  // Wait for agentProvenance to be available for new agents (continueSession=false)
  useEffect(() => {
    if (
      loadingState === "ready" &&
      !welcomeCommittedRef.current &&
      messageHistory.length === 0
    ) {
      // For new agents, wait until provenance is available
      // For resumed agents, provenance stays null (that's expected)
      if (!continueSession && !agentProvenance) {
        return; // Wait for provenance to be set
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

      // Add status line showing agent info
      const statusId = `status-agent-${Date.now().toString(36)}`;

      // Check if agent is pinned
      const isPinned = agentState?.id
        ? settingsManager.isAgentPinned(agentState.id)
        : false;

      // Build status message based on session type
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

      // Build status lines with optional release notes above header
      const statusLines: string[] = [];

      const startupSystemPromptWarning =
        buildStartupSystemPromptWarning(agentState);

      // Add release notes first (above everything) - same styling as rest of status block
      if (releaseNotes) {
        statusLines.push(releaseNotes);
        statusLines.push(""); // blank line separator
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
        handleQuestionSubmit={handleQuestionSubmit}
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
        interruptRequested={interruptRequested}
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
