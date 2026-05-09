// src/cli/app/AppCoordinator.tsx

import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { APIError } from "@letta-ai/letta-client/core/error";
import type {
  AgentState,
  MessageCreate,
} from "@letta-ai/letta-client/resources/agents/agents";
import type { ApprovalCreate } from "@letta-ai/letta-client/resources/agents/messages";
import type { LlmConfig } from "@letta-ai/letta-client/resources/models/models";
import { Box } from "ink";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  type ApprovalResult,
  getDisplayableToolReturn,
} from "../../agent/approval-execution";
import {
  buildFreshDenialApprovals,
  extractConflictDetail,
  getPreStreamErrorAction,
  rebuildInputWithFreshDenials,
  STALE_APPROVAL_RECOVERY_DENIAL_REASON,
  shouldAttemptApprovalRecovery,
} from "../../agent/approval-recovery";
import { prefetchAvailableModelHandles } from "../../agent/available-models";
import { getResumeDataFromBackend } from "../../agent/check-approval";
import { setCurrentAgentId } from "../../agent/context";
import { createAgent } from "../../agent/create";
import { selectDefaultAgentModel } from "../../agent/defaults";
import { ISOLATED_BLOCK_LABELS } from "../../agent/memory";
import { getScopedMemoryFilesystemRoot } from "../../agent/memoryFilesystem";
import { sendMessageStream } from "../../agent/message";
import {
  getModelInfoForLlmConfig,
  getModelShortName,
  type ModelReasoningEffort,
} from "../../agent/model";
import type { PersonalityId } from "../../agent/personality";
import { shouldRecommendDefaultPrompt } from "../../agent/promptAssets";
import { reconcileExistingAgentState } from "../../agent/reconcileExistingAgentState";
import { recordSessionEnd } from "../../agent/sessionHistory";
import { SessionStats } from "../../agent/stats";
import { getBackend } from "../../backend";
import { getClient, getServerUrl } from "../../backend/api/client";
import {
  getBillingTier,
  submitFeedbackMetadata,
} from "../../backend/api/metadata";
import { INTERRUPTED_BY_USER } from "../../constants";
import { experimentManager } from "../../experiments/manager";
import type { ExperimentId } from "../../experiments/types";
import { runSessionEndHooks, runSessionStartHooks } from "../../hooks";
import type { ApprovalContext } from "../../permissions/analyzer";
import { type PermissionMode, permissionMode } from "../../permissions/mode";
import { OPENAI_CODEX_PROVIDER_NAME } from "../../providers/openai-codex-provider";
import {
  type MessageQueueItem,
  QueueRuntime,
  type TaskNotificationQueueItem,
} from "../../queue/queueRuntime";
import { ralphMode } from "../../ralph/mode";
import {
  createSharedReminderState,
  enqueueCommandIoReminder,
  enqueueToolsetChangeReminder,
  resetSharedReminderState,
} from "../../reminders/state";
import { getCurrentWorkingDirectory } from "../../runtime-context";
import { updateProjectSettings } from "../../settings";
import { settingsManager } from "../../settings-manager";
import { telemetry } from "../../telemetry";
import {
  analyzeToolApproval,
  checkToolPermission,
  executeTool,
  releaseToolExecutionContext,
  savePermissionRule,
  type ToolExecutionResult,
} from "../../tools/manager";
import {
  prepareToolExecutionContextForResolvedTarget,
  prepareToolExecutionContextForScope,
  type ToolsetName,
  type ToolsetPreference,
} from "../../tools/toolset";
import {
  debugLog,
  debugLogFile,
  debugWarn,
  isDebugEnabled,
} from "../../utils/debug";
import { recordTuiPerf } from "../../utils/tuiPerf";
import { getVersion } from "../../version";
import {
  type CommandFinishedEvent,
  type CommandHandle,
  createCommandRunner,
} from "../commands/runner";
import { AgentSelector } from "../components/AgentSelector";
import { ApprovalSwitch } from "../components/ApprovalSwitch";
import { AssistantMessage } from "../components/AssistantMessageRich";
import { BashCommandMessage } from "../components/BashCommandMessage";
import { BtwPane, type BtwState } from "../components/BtwPane";
import { CommandMessage } from "../components/CommandMessage";
import { CompactionSelector } from "../components/CompactionSelector";
import { ConversationSelector } from "../components/ConversationSelector";
// EnterPlanModeDialog removed - now using InlineEnterPlanModeApproval
import { ErrorMessage } from "../components/ErrorMessageRich";
import { EventMessage } from "../components/EventMessage";
import { ExperimentSelector } from "../components/ExperimentSelector";
import { FeedbackDialog } from "../components/FeedbackDialog";
import { HelpDialog } from "../components/HelpDialog";
import { HooksManager } from "../components/HooksManager";
import { Input } from "../components/InputRich";
import { InstallGithubAppFlow } from "../components/InstallGithubAppFlow";
import { McpConnectFlow } from "../components/McpConnectFlow";
import { McpSelector } from "../components/McpSelector";
import { MemfsTreeViewer } from "../components/MemfsTreeViewer";
import { MemoryTabViewer } from "../components/MemoryTabViewer";
import { MessageSearch } from "../components/MessageSearch";
import { ModelReasoningSelector } from "../components/ModelReasoningSelector";
import { ModelSelector } from "../components/ModelSelector";
import { NewAgentDialog } from "../components/NewAgentDialog";
import { PendingApprovalStub } from "../components/PendingApprovalStub";
import { PersonalitySelector } from "../components/PersonalitySelector";
import { PinDialog } from "../components/PinDialog";
import { ProviderSelector } from "../components/ProviderSelector";
import { ReasoningMessage } from "../components/ReasoningMessageRich";
import { SkillsDialog } from "../components/SkillsDialog";
import { SleeptimeSelector } from "../components/SleeptimeSelector";
// InlinePlanApproval kept for easy rollback if needed
// import { InlinePlanApproval } from "../components/InlinePlanApproval";
import { StatusMessage } from "../components/StatusMessage";
import { SubagentGroupDisplay } from "../components/SubagentGroupDisplay";
import { SubagentManager } from "../components/SubagentManager";
import { SystemPromptSelector } from "../components/SystemPromptSelector";
import { ToolCallMessage } from "../components/ToolCallMessageRich";
import { ToolsetSelector } from "../components/ToolsetSelector";
import { UserMessage } from "../components/UserMessageRich";
import { WelcomeScreen } from "../components/WelcomeScreen";
import { AnimationProvider } from "../contexts/AnimationContext";
import {
  appendStreamingOutput,
  type Buffers,
  createBuffers,
  extractTextPart,
  type Line,
  markIncompleteToolsAsCancelled,
  onChunk,
  setToolCallsRunning,
  toLines,
} from "../helpers/accumulator";
import { buildChatUrl } from "../helpers/appUrls";
import { backfillBuffers } from "../helpers/backfill";
import { chunkLog } from "../helpers/chunkLog";
import {
  createContextTracker,
  resetContextHistory,
} from "../helpers/contextTracker";
import {
  generateConversationTitleFromFork,
  normalizeConversationTitle,
} from "../helpers/conversationTitle";
import type { AdvancedDiffSuccess } from "../helpers/diff";
import { setErrorContext } from "../helpers/errorContext";
import { formatErrorDetails } from "../helpers/errorFormatter";
import { parsePatchOperations } from "../helpers/formatArgsDisplay";
import {
  getReflectionSettings,
  parseMemoryPreference,
  type ReflectionSettings,
} from "../helpers/memoryReminder";
import {
  type QueuedMessage,
  setMessageQueueAdder,
} from "../helpers/messageQueueBridge";
import { resolvePlaceholders } from "../helpers/pasteRegistry";
import { generatePlanFilePath } from "../helpers/planName";
import {
  buildContentFromQueueBatch,
  buildQueuedContentParts,
  buildQueuedUserText,
  getQueuedNotificationSummaries,
  toQueuedMsg,
} from "../helpers/queuedMessageParts";
import { safeJsonParseOr } from "../helpers/safeJsonParse";
import { getDeviceType, getLocalTime } from "../helpers/sessionContext";
import type { ApprovalRequest } from "../helpers/stream";
import {
  collectFinishedTaskToolCalls,
  createSubagentGroupItem,
  hasInProgressTaskToolCalls,
} from "../helpers/subagentAggregation";
import {
  clearSubagentsByIds,
  getActiveBackgroundAgents,
  getSubagentByToolCallId,
  getSnapshot as getSubagentSnapshot,
  interruptActiveSubagents,
  subscribe as subscribeToSubagents,
} from "../helpers/subagentState";
import { flushEligibleLinesBeforeReentry } from "../helpers/subagentTurnStart";
import { buildStartupSystemPromptWarning } from "../helpers/systemPromptWarning.ts";
import { appendTaskNotificationEventsToBuffer } from "../helpers/taskNotifications";
import { getRandomThinkingVerb } from "../helpers/thinkingMessages";
import {
  isFileEditTool,
  isFileWriteTool,
  isPatchTool,
  isShellTool,
} from "../helpers/toolNameMapping";
import { isTaskTool } from "../helpers/toolNameMapping.js";
import { getTuiBlockedReason } from "../helpers/tuiQueueAdapter";
import { useConfigurableStatusLine } from "../hooks/useConfigurableStatusLine";
import { useSuspend } from "../hooks/useSuspend/useSuspend.ts";
import { useSyncedState } from "../hooks/useSyncedState";
import { useTerminalRows, useTerminalWidth } from "../hooks/useTerminalWidth";

import { buildApprovalBatchKey } from "./approvalDiffs";
import { getQuestionsFromApproval } from "./approvalQuestions";
import {
  ANIMATION_RESUME_HYSTERESIS_ROWS,
  APPROVAL_OPTIONS_HEIGHT,
  APPROVAL_PREVIEW_BUFFER,
  CLEAR_SCREEN_AND_HOME,
  DIFF_WRAP_GUTTER,
  EAGER_CANCEL,
  INTERRUPT_MESSAGE,
  LLM_API_ERROR_MAX_RETRIES,
  MIN_CLEAR_INTERVAL_MS,
  MIN_RESIZE_DELTA,
  MIN_WRAP_WIDTH,
  RESIZE_SETTLE_MS,
  SHELL_PREVIEW_MAX_LINES,
  STABLE_WIDTH_SETTLE_MS,
  TEXT_WRAP_GUTTER,
  TOOL_CALL_COMMIT_DEFER_MS,
} from "./constants";
import { ExitStats } from "./ExitStats";
import { extractErrorMeta } from "./errors";
import { appendOptimisticUserLine, createClientOtid, uid } from "./ids";
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
} from "./modelConfig";
import { sendDesktopNotification } from "./notifications";
import { _readPlanFile, planFileExists } from "./planFile";
import { StaticTranscript } from "./StaticTranscript";
import { saveLastSessionBeforeExit } from "./session";
import type { AppProps, StaticItem } from "./types";
import { useConfigurationHandlers } from "./useConfigurationHandlers";
import { useConversationLoop } from "./useConversationLoop";
import { useSubmitHandler } from "./useSubmitHandler";

export default function App({
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
  releaseNotes = null,
  updateNotification = null,
  systemInfoReminderEnabled = true,
}: AppProps) {
  // Warm the model-access cache in the background so /model is fast on first open.
  useEffect(() => {
    prefetchAvailableModelHandles();
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
    | import("../helpers/conversationSwitchAlert").ConversationSwitchContext
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

  // Set terminal title to "{Agent Name} | Letta Code"
  useEffect(() => {
    const title = agentState?.name
      ? `${agentState.name} | Letta Code`
      : "Letta Code";
    process.stdout.write(`\x1b]0;${title}\x07`);
  }, [agentState?.name]);

  // Whether a stream is in flight (disables input)
  // Uses synced state to keep ref in sync for reliable async checks
  const [streaming, setStreaming, streamingRef] = useSyncedState(false);
  const [networkPhase, setNetworkPhase] = useState<
    "upload" | "download" | "error" | null
  >(null);
  // Track permission mode changes for UI updates.
  // Keep a ref in sync *synchronously* so async approval classification never
  // reads a stale mode during the render/effect window.
  const [uiPermissionMode, _setUiPermissionMode] = useState(
    permissionMode.getMode(),
  );
  const uiPermissionModeRef = useRef<PermissionMode>(uiPermissionMode);

  // Store the last plan file path for post-approval rendering
  // (needed because plan mode is exited before rendering the result)
  const lastPlanFilePathRef = useRef<string | null>(null);
  const cacheLastPlanFilePath = useCallback((planFilePath: string | null) => {
    if (planFilePath) {
      lastPlanFilePathRef.current = planFilePath;
    }
  }, []);

  const setUiPermissionMode = useCallback(
    (mode: PermissionMode) => {
      uiPermissionModeRef.current = mode;
      _setUiPermissionMode(mode);

      // Keep the permissionMode singleton in sync *immediately*.
      //
      // We also have a useEffect sync (below) as a safety net, but relying on it
      // introduces a render/effect window where the UI can show YOLO while the
      // singleton still reports an older mode. That window is enough to break
      // plan-mode restoration (plan remembers the singleton's mode-at-entry).
      if (permissionMode.getMode() !== mode) {
        // If entering plan mode via UI state, ensure a plan file path is set.
        if (mode === "plan" && !permissionMode.getPlanFilePath()) {
          const planPath = generatePlanFilePath();
          permissionMode.setPlanFilePath(planPath);
          cacheLastPlanFilePath(planPath);
        }
        permissionMode.setMode(mode);
      }
    },
    [cacheLastPlanFilePath],
  );

  const statusLineTriggerVersionRef = useRef(0);
  const [statusLineTriggerVersion, setStatusLineTriggerVersion] = useState(0);

  useEffect(() => {
    if (!streaming) {
      setNetworkPhase(null);
    }
  }, [streaming]);

  const triggerStatusLineRefresh = useCallback(() => {
    statusLineTriggerVersionRef.current += 1;
    setStatusLineTriggerVersion(statusLineTriggerVersionRef.current);
  }, []);

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
  const lastAutoApprovedEnterPlanToolCallIdRef = useRef<string | null>(null);
  const lastAutoHandledExitPlanToolCallIdRef = useRef<string | null>(null);
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

  // Ralph Wiggum mode: config waiting for next message to capture as prompt
  const [pendingRalphConfig, setPendingRalphConfig] = useState<{
    completionPromise: string | null | undefined;
    maxIterations: number;
    isYolo: boolean;
  } | null>(null);

  // Track ralph mode for UI updates (singleton state doesn't trigger re-renders)
  const [uiRalphActive, setUiRalphActive] = useState(
    ralphMode.getState().isActive,
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
          const cmd =
            typeof args.command === "string"
              ? args.command
              : Array.isArray(args.command)
                ? args.command.join(" ")
                : "";
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
  type ActiveOverlay =
    | "model"
    | "experiment"
    | "sleeptime"
    | "compaction"
    | "toolset"
    | "system"
    | "personality"
    | "agent"
    | "resume"
    | "conversations"
    | "search"
    | "subagent"
    | "feedback"
    | "memory"
    | "memfs-sync"
    | "pin"
    | "new"
    | "mcp"
    | "mcp-connect"
    | "install-github-app"
    | "help"
    | "hooks"
    | "connect"
    | "skills"
    | null;
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
    options: Array<{ effort: ModelReasoningEffort; modelId: string }>;
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
  type QueuedOverlayAction =
    | { type: "switch_agent"; agentId: string; commandId?: string }
    | { type: "switch_model"; modelId: string; commandId?: string }
    | {
        type: "set_experiment";
        experimentId: ExperimentId;
        enabled: boolean;
        commandId?: string;
      }
    | {
        type: "set_sleeptime";
        settings: ReflectionSettings;
        commandId?: string;
      }
    | {
        type: "set_compaction";
        mode: string;
        commandId?: string;
      }
    | {
        type: "switch_conversation";
        conversationId: string;
        commandId?: string;
      }
    | {
        type: "switch_toolset";
        toolsetId: ToolsetPreference;
        commandId?: string;
      }
    | { type: "switch_system"; promptId: string; commandId?: string }
    | {
        type: "switch_personality";
        personalityId: PersonalityId;
        commandId?: string;
      }
    | null;
  const [queuedOverlayAction, setQueuedOverlayAction] =
    useState<QueuedOverlayAction>(null);

  // Pin dialog state
  const [pinDialogLocal, setPinDialogLocal] = useState(false);

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
  const [
    conversationOverrideContextWindowLimit,
    setConversationOverrideContextWindowLimit,
  ] = useState<number | null>(null);
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

  // Use tier-aware resolution so the display matches the agent's reasoning effort
  // (e.g. "GPT-5.3-Codex" not just "GPT-5" for the first match).
  const currentModelDisplay = useMemo(() => {
    if (!currentModelLabel) return null;
    const info = getModelInfoForLlmConfig(currentModelLabel, {
      reasoning_effort: derivedReasoningEffort ?? null,
      enable_reasoner:
        (llmConfig as { enable_reasoner?: boolean | null })?.enable_reasoner ??
        null,
      context_window: llmConfig?.context_window ?? null,
    });
    if (info) {
      return (info as { shortLabel?: string }).shortLabel ?? info.label;
    }
    return (
      getModelShortName(currentModelLabel) ??
      currentModelLabel.split("/").pop() ??
      null
    );
  }, [currentModelLabel, derivedReasoningEffort, llmConfig]);
  const currentModelProvider = llmConfig?.provider_name ?? null;
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
    });
  }, [currentModelDisplay, billingTier, llmConfig?.model_endpoint_type]);

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

  // Live, approximate token counter (resets each turn)
  const [tokenCount, setTokenCount] = useState(0);

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

  // Session stats tracking
  const sessionStatsRef = useRef(new SessionStats());
  const sessionStartTimeRef = useRef(Date.now());
  const sessionHooksRanRef = useRef(false);

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
  const runEndHooks = useCallback(async () => {
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
  }, []);

  // Show exit stats on exit (double Ctrl+C)
  const [showExitStats, setShowExitStats] = useState(false);

  const sharedReminderStateRef = useRef(createSharedReminderState());
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
  const firstUserQueryRef = useRef<string | null>(null);
  const setConversationAutoTitleEligibility = useCallback(
    (enabled: boolean) => {
      shouldAutoGenerateConversationTitleRef.current = enabled;
      isAutoConversationTitleInFlightRef.current = false;
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
    if (!experimentManager.isEnabled("conversation_titles")) {
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
      const client = await getClient();
      const aiTitle = await generateConversationTitleFromFork(
        client,
        conversationId,
      );
      return aiTitle ?? fallback;
    } catch (err) {
      if (isDebugEnabled()) {
        console.error("[DEBUG] generateConversationTitle failed:", err);
      }
      return fallback;
    }
  }, [deriveAutoConversationTitle]);
  const resetBootstrapReminderState = useCallback(() => {
    resetSharedReminderState(sharedReminderStateRef.current);
  }, []);
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
        });
      }

      if (desiredModel) {
        return prepareToolExecutionContextForResolvedTarget({
          modelIdentifier: desiredModel,
          toolsetPreference: currentToolsetPreference,
          workingDirectory,
        });
      }

      return prepareToolExecutionContextForResolvedTarget({
        modelIdentifier: null,
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
            (!ln.name || !isTaskTool(ln.name))
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

  // Configurable status line hook
  const sessionStatsSnapshot = sessionStatsRef.current.getSnapshot();
  const reflectionSettings = getReflectionSettings(agentId);
  const memfsEnabled = settingsManager.isMemfsEnabled(agentId);
  const _memfsDirectory =
    memfsEnabled && agentId && agentId !== "loading"
      ? getScopedMemoryFilesystemRoot(agentId)
      : null;
  const statusLine = useConfigurableStatusLine({
    modelId: llmConfigRef.current?.model ?? null,
    modelDisplayName: currentModelDisplay,
    reasoningEffort: currentReasoningEffort,
    systemPromptId: currentSystemPromptId,
    toolset: currentToolset,
    currentDirectory: process.cwd(),
    projectDirectory,
    sessionId: conversationId,
    agentId,
    agentName,
    lastRunId: lastRunIdRef.current,
    totalDurationMs: sessionStatsSnapshot.totalWallMs,
    totalApiDurationMs: sessionStatsSnapshot.totalApiMs,
    totalInputTokens: sessionStatsSnapshot.usage.promptTokens,
    totalOutputTokens: sessionStatsSnapshot.usage.completionTokens,
    contextWindowSize: effectiveContextWindowSize,
    usedContextTokens: contextTrackerRef.current.lastContextTokens,
    stepCount: sessionStatsSnapshot.usage.stepCount,
    turnCount: sharedReminderStateRef.current.turnCount,
    reflectionMode: reflectionSettings.trigger,
    reflectionStepCount: reflectionSettings.stepCount,
    permissionMode: uiPermissionMode,
    networkPhase,
    terminalWidth: chromeColumns,
    backgroundAgents: getActiveBackgroundAgents().map((a) => ({
      type: a.type,
      status: a.status,
      duration_ms: Date.now() - a.startTime,
    })),
    triggerVersion: statusLineTriggerVersion,
  });

  const previousStreamingForStatusLineRef = useRef(streaming);
  useEffect(() => {
    // Trigger status line when an assistant stream completes.
    if (previousStreamingForStatusLineRef.current && !streaming) {
      triggerStatusLineRefresh();
    }
    previousStreamingForStatusLineRef.current = streaming;
  }, [streaming, triggerStatusLineRefresh]);

  const statusLineRefreshIdentity = `${conversationId}|${currentModelDisplay ?? ""}|${currentModelProvider ?? ""}|${agentName ?? ""}|${columns}|${effectiveContextWindowSize ?? ""}|${currentReasoningEffort ?? ""}|${currentSystemPromptId ?? ""}|${currentToolset ?? ""}`;

  // Trigger status line when key session identity/display state changes.
  useEffect(() => {
    void statusLineRefreshIdentity;
    triggerStatusLineRefresh();
  }, [statusLineRefreshIdentity, triggerStatusLineRefresh]);

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

        if (t === "shell") {
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
    if (currentApproval.toolName === "ExitPlanMode") return false;
    return shouldEagerCommitApprovalPreview(currentApproval);
  }, [currentApproval, shouldEagerCommitApprovalPreview]);

  // Recompute UI state from buffers after each streaming chunk
  const refreshDerived = useCallback(() => {
    const b = buffersRef.current;
    setTokenCount(b.tokenCount);
    const newLines = toLines(b);
    setLines(newLines);
    commitEligibleLines(b);
  }, [commitEligibleLines]);
  refreshDerivedRef.current = refreshDerived;

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

  // Eager commit for ExitPlanMode: Always commit plan preview to staticItems
  // This keeps the dynamic area small (just approval options) to avoid flicker
  useEffect(() => {
    if (!currentApproval) return;
    if (currentApproval.toolName !== "ExitPlanMode") return;

    const toolCallId = currentApproval.toolCallId;
    if (!toolCallId) return;

    // Already committed preview for this approval?
    if (eagerCommittedPreviewsRef.current.has(toolCallId)) return;

    const planFilePath = permissionMode.getPlanFilePath();
    if (!planFilePath) return;

    try {
      const { readFileSync, existsSync } = require("node:fs");
      if (!existsSync(planFilePath)) return;

      const planContent = readFileSync(planFilePath, "utf-8");

      // Commit preview to static area
      const previewItem: StaticItem = {
        kind: "approval_preview",
        id: `approval-preview-${toolCallId}`,
        toolCallId,
        toolName: currentApproval.toolName,
        toolArgs: currentApproval.toolArgs || "{}",
        planContent,
        planFilePath,
      };

      setStaticItems((prev) => [...prev, previewItem]);
      eagerCommittedPreviewsRef.current.add(toolCallId);

      // Also capture plan file path for post-approval rendering
      lastPlanFilePathRef.current = planFilePath;
    } catch {
      // Failed to read plan, don't commit preview
    }
  }, [currentApproval]);

  // Eager commit for large approval previews (bash/file edits) to avoid flicker
  useEffect(() => {
    if (!currentApproval) return;
    if (currentApproval.toolName === "ExitPlanMode") return;

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

  // Backfill message history when resuming (only once)
  useEffect(() => {
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
              agentProvenance,
              terminalWidth: columns,
            },
          },
        ]);
      }
      // Use backfillBuffers to properly populate the transcript from history
      backfillBuffers(buffersRef.current, messageHistory);

      // Add combined status at the END so user sees it without scrolling
      const statusId = `status-resumed-${Date.now().toString(36)}`;

      // Check if agent is pinned (locally or globally)
      const isPinned = agentState?.id
        ? settingsManager.getLocalPinnedAgents().includes(agentState.id) ||
          settingsManager.getGlobalPinnedAgents().includes(agentState.id)
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

      // Command hints - vary based on agent state:
      // - Resuming: show /new (they may want a fresh conversation)
      // - New session + unpinned: show /pin (they should save their agent)
      // - New session + pinned: show /memory (they're already saved)
      const commandHints = isResumingConversation
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
    agentProvenance,
    resumedExistingConversation,
    releaseNotes,
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
                "../../agent/promptAssets"
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
          const { getModelInfoForLlmConfig } = await import(
            "../../agent/model"
          );
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
              const { switchToolsetForModel } = await import(
                "../../tools/toolset"
              );
              const derivedToolset = await switchToolsetForModel(
                agentModelHandle,
                agentId,
              );
              setCurrentToolset(derivedToolset);
            } else {
              setCurrentToolset(null);
            }
          } else {
            const { forceToolsetSwitch } = await import("../../tools/toolset");
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
  }, [loadingState, agentId, initialAgentState]);

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

        const reasoningEffort = deriveReasoningEffort(
          conversationModelSettings,
          agentState.llm_config,
        );

        const modelInfo = getModelInfoForLlmConfig(effectiveModelHandle, {
          reasoning_effort: reasoningEffort,
          enable_reasoner:
            (
              agentState.llm_config as {
                enable_reasoner?: boolean | null;
              }
            ).enable_reasoner ?? null,
          context_window: conversationContextWindowLimit ?? null,
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
        setConversationOverrideModelSettings(conversationModelSettings ?? null);
        setConversationOverrideContextWindowLimit(
          resolvedConversationContextWindowLimit,
        );
        setCurrentModelHandle(effectiveModelHandle);
        setCurrentModelId(modelInfo?.id ?? effectiveModelHandle);
        setLlmConfig({
          ...agentState.llm_config,
          ...mapHandleToLlmConfigPatch(effectiveModelHandle),
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

      // Keep provider naming aligned with model handles used by /model.
      const [provider, ...modelParts] = rawModelHandle.split("/");
      const modelHandle =
        provider === "chatgpt_oauth" && modelParts.length > 0
          ? `${OPENAI_CODEX_PROVIDER_NAME}/${modelParts.join("/")}`
          : rawModelHandle;

      const modelInfo = getModelInfoForLlmConfig(modelHandle, {
        reasoning_effort: currentLlmConfig?.reasoning_effort ?? null,
        enable_reasoner:
          (currentLlmConfig as { enable_reasoner?: boolean | null } | null)
            ?.enable_reasoner ?? null,
      });

      const updateArgs: Record<string, unknown> = {
        ...((modelInfo?.updateArgs as Record<string, unknown> | undefined) ??
          {}),
      };
      const reasoningEffort = currentLlmConfig?.reasoning_effort;
      if (
        typeof reasoningEffort === "string" &&
        updateArgs.reasoning_effort === undefined
      ) {
        updateArgs.reasoning_effort = reasoningEffort;
      }
      const enableReasoner = (
        currentLlmConfig as { enable_reasoner?: boolean | null } | null
      )?.enable_reasoner;
      if (
        typeof enableReasoner === "boolean" &&
        updateArgs.enable_reasoner === undefined
      ) {
        updateArgs.enable_reasoner = enableReasoner;
      }

      try {
        const { updateConversationLLMConfig } = await import(
          "../../agent/modify"
        );
        await updateConversationLLMConfig(
          targetConversationId,
          modelHandle,
          Object.keys(updateArgs).length > 0 ? updateArgs : undefined,
          { preserveContextWindow: true },
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
            "../../agent/memoryGit"
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
          "../../agent/memoryGit"
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
    contextTrackerRef,
    conversationBusyRetriesRef,
    conversationGenerationRef,
    conversationIdRef,
    currentModelId,
    emptyResponseRetriesRef,
    executingToolCallIdsRef,
    generateConversationTitle,
    hasConversationModelOverrideRef,
    interruptQueuedRef,
    isAutoConversationTitleInFlightRef,
    lastDequeuedMessageRef,
    lastRunIdRef,
    lastSentInputRef,
    llmApiErrorRetriesRef,
    llmConfigRef,
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
    setIsExecutingTool,
    setLlmConfig,
    setNeedsEagerApprovalCheck,
    setNetworkPhase,
    setPendingApprovals,
    setRestoreQueueOnCancel,
    setRestoredInput,
    setStreaming,
    setTempModelOverride,
    setThinkingMessage,
    setTrajectoryElapsedBaseMs,
    setTrajectoryTokenBase,
    setUiPermissionMode,
    setUiRalphActive,
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

  const restorePendingApprovalUi = useCallback(
    async (
      approvals: ApprovalRequest[],
      contexts?: ApprovalContext[],
    ): Promise<void> => {
      setPendingApprovals(approvals);

      if (contexts) {
        setApprovalContexts(contexts);
        return;
      }

      try {
        const analyzedContexts = await Promise.all(
          approvals.map(async (approval) => {
            const parsedArgs = safeJsonParseOr<Record<string, unknown>>(
              approval.toolArgs,
              {},
            );
            return await analyzeToolApproval(approval.toolName, parsedArgs);
          }),
        );
        setApprovalContexts(analyzedContexts);
      } catch (error) {
        debugLog(
          "approvals",
          "Failed to analyze restored approvals: %O",
          error,
        );
        setApprovalContexts([]);
      }
    },
    [],
  );

  const recoverRestoredPendingApprovals = useCallback(
    async (
      approvals: ApprovalRequest[],
      _options: { notifyOnManualApproval?: boolean } = {},
    ): Promise<void> => {
      if (approvals.length === 0) {
        return;
      }

      const generationAtStart = conversationGenerationRef.current;
      const batchKey = buildApprovalBatchKey(approvals);
      const currentRecovery = restoredApprovalRecoveryRef.current;
      if (
        currentRecovery.batchKey === batchKey &&
        currentRecovery.generation === generationAtStart &&
        currentRecovery.status !== "idle"
      ) {
        return;
      }

      restoredApprovalRecoveryRef.current = {
        batchKey,
        generation: generationAtStart,
        status: "running",
      };

      const queuedMetadata = queuedApprovalMetadataRef.current;
      const hasQueuedRealResults =
        queuedApprovalResultsRef.current !== null &&
        queuedApprovalResultsRef.current.length > 0 &&
        queuedMetadata?.conversationId === conversationIdRef.current &&
        queuedMetadata.generation === generationAtStart;

      setApprovalResults([]);
      setAutoHandledResults([]);
      setAutoDeniedApprovals([]);
      setApprovalContexts([]);
      setPendingApprovals([]);

      try {
        if (conversationGenerationRef.current !== generationAtStart) {
          restoredApprovalRecoveryRef.current = {
            batchKey,
            generation: generationAtStart,
            status: "completed",
          };
          return;
        }

        if (hasQueuedRealResults) {
          setNeedsEagerApprovalCheck(false);
          restoredApprovalRecoveryRef.current = {
            batchKey,
            generation: generationAtStart,
            status: "completed",
          };
          return;
        }

        const staleDenials = buildFreshDenialApprovals(
          approvals,
          STALE_APPROVAL_RECOVERY_DENIAL_REASON,
        ) as ApprovalResult[];
        if (staleDenials.length > 0) {
          queueApprovalResults(staleDenials, {
            conversationId: conversationIdRef.current,
            generation: generationAtStart,
          });
          setNeedsEagerApprovalCheck(false);
        }

        restoredApprovalRecoveryRef.current = {
          batchKey,
          generation: generationAtStart,
          status: "completed",
        };
      } catch (error) {
        debugLog(
          "approvals",
          "Failed to recover restored approvals automatically: %O",
          error,
        );
        await restorePendingApprovalUi(approvals);
        setAutoHandledResults([]);
        setAutoDeniedApprovals([]);
        sendDesktopNotification("Approval needed");
        restoredApprovalRecoveryRef.current = {
          batchKey,
          generation: generationAtStart,
          status: "completed",
        };
      }
    },
    [queueApprovalResults, restorePendingApprovalUi],
  );

  useEffect(() => {
    void conversationId;
    restoredApprovalRecoveryRef.current = {
      batchKey: null,
      generation: conversationGenerationRef.current,
      status: "idle",
    };
  }, [conversationId]);

  // Restore pending approval from startup when ready.
  useEffect(() => {
    const approvals =
      startupApprovals?.length > 0
        ? startupApprovals
        : startupApproval
          ? [startupApproval]
          : [];

    if (loadingState === "ready" && approvals.length > 0) {
      void recoverRestoredPendingApprovals(approvals);
    }
  }, [
    loadingState,
    recoverRestoredPendingApprovals,
    startupApproval,
    startupApprovals,
  ]);

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

  // Handler when user presses UP/ESC to load queue into input for editing
  const handleEnterQueueEditMode = useCallback(() => {
    tuiQueueRef.current?.clear("stale_generation");
  }, []);

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

  const handleInterrupt = useCallback(async () => {
    // If we're executing client-side tools, abort them AND the main stream
    const hasTrackedTools =
      executingToolCallIdsRef.current.length > 0 ||
      autoAllowedExecutionRef.current?.results;
    if (
      isExecutingTool &&
      toolAbortControllerRef.current &&
      hasTrackedTools &&
      !toolResultsInFlightRef.current
    ) {
      toolAbortControllerRef.current.abort();

      // Mark any in-flight conversation as stale, consistent with EAGER_CANCEL.
      // Increment before tagging queued results so they are tied to the post-interrupt state.
      conversationGenerationRef.current += 1;
      processingConversationRef.current = 0;

      const autoAllowedResults = autoAllowedExecutionRef.current?.results;
      const autoAllowedMetadata = autoAllowedExecutionRef.current
        ? {
            conversationId: autoAllowedExecutionRef.current.conversationId,
            generation: conversationGenerationRef.current,
          }
        : undefined;
      if (autoAllowedResults && autoAllowedResults.length > 0) {
        queueApprovalResults(autoAllowedResults, autoAllowedMetadata);
        interruptQueuedRef.current = true;
      } else if (executingToolCallIdsRef.current.length > 0) {
        const interruptedResults = executingToolCallIdsRef.current.map(
          (toolCallId) => ({
            type: "tool" as const,
            tool_call_id: toolCallId,
            tool_return: INTERRUPTED_BY_USER,
            status: "error" as const,
          }),
        );
        queueApprovalResults(interruptedResults);
        interruptQueuedRef.current = true;
      }
      executingToolCallIdsRef.current = [];
      autoAllowedExecutionRef.current = null;

      // ALSO abort the main stream - don't leave it running
      buffersRef.current.abortGeneration =
        (buffersRef.current.abortGeneration || 0) + 1;
      const toolsCancelled = markIncompleteToolsAsCancelled(
        buffersRef.current,
        true,
        "user_interrupt",
      );

      // Mark any running subagents as interrupted
      interruptActiveSubagents(INTERRUPTED_BY_USER);

      // Show interrupt feedback (yellow message if no tools were cancelled)
      if (!toolsCancelled) {
        appendError(INTERRUPT_MESSAGE, true);
      }

      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }

      pendingInterruptRecoveryConversationIdRef.current =
        conversationIdRef.current;
      userCancelledRef.current = true; // Prevent dequeue
      setStreaming(false);
      resetTrajectoryBases();
      setIsExecutingTool(false);
      toolResultsInFlightRef.current = false;
      refreshDerived();

      // Send cancel request to backend (fire-and-forget).
      // Without this, the backend stays in requires_approval state after tool interrupt,
      // causing CONFLICT on the next user message.
      Promise.resolve()
        .then(() => {
          const cancelConversationId =
            conversationIdRef.current === "default"
              ? agentIdRef.current
              : conversationIdRef.current;
          if (!cancelConversationId || cancelConversationId === "loading") {
            return;
          }
          return getBackend().cancelConversation(cancelConversationId);
        })
        .catch(() => {
          // Silently ignore - cancellation already happened client-side
        });

      // Delay flag reset to ensure React has flushed state updates before dequeue can fire.
      // Use setTimeout(50) instead of setTimeout(0) - the longer delay ensures React's
      // batched state updates have been fully processed before we allow the dequeue effect.
      setTimeout(() => {
        userCancelledRef.current = false;
      }, 50);

      return;
    }

    if (!streaming || interruptRequested) {
      return;
    }

    // If we're in the middle of queue cancel, set flag to restore instead of auto-send
    if (waitingForQueueCancelRef.current) {
      setRestoreQueueOnCancel(true);
      // Don't reset flags - let the cancel complete naturally
    }

    // If EAGER_CANCEL is enabled, immediately stop everything client-side first
    if (EAGER_CANCEL) {
      // Prevent multiple handleInterrupt calls while state updates are pending
      setInterruptRequested(true);

      // Set interrupted flag FIRST, before abort() triggers any async work.
      // This ensures onChunk and other guards see interrupted=true immediately.
      buffersRef.current.abortGeneration =
        (buffersRef.current.abortGeneration || 0) + 1;
      const toolsCancelled = markIncompleteToolsAsCancelled(
        buffersRef.current,
        true,
        "user_interrupt",
      );

      // Mark any running subagents as interrupted
      interruptActiveSubagents(INTERRUPTED_BY_USER);

      // NOW abort the stream - interrupted flag is already set
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null; // Clear ref so isAgentBusy() returns false
      }

      // Set cancellation flag to prevent processConversation from starting
      pendingInterruptRecoveryConversationIdRef.current =
        conversationIdRef.current;
      userCancelledRef.current = true;

      // Increment generation to mark any in-flight processConversation as stale.
      // The stale processConversation will check this and exit quietly without
      // decrementing the ref (since we reset it here).
      conversationGenerationRef.current += 1;

      // Reset the processing guard so the next message can start a new conversation.
      processingConversationRef.current = 0;

      // Stop streaming and show error message (unless tool calls were cancelled,
      // since the tool result will show "Interrupted by user")
      setStreaming(false);
      resetTrajectoryBases();
      toolResultsInFlightRef.current = false;
      setIsExecutingTool(false);
      if (!toolsCancelled) {
        appendError(INTERRUPT_MESSAGE, true);
      }
      refreshDerived();

      // Cache pending approvals, plus any auto-handled results, for the next message.
      const denialResults = pendingApprovals.map((approval) => ({
        type: "approval" as const,
        tool_call_id: approval.toolCallId,
        approve: false,
        reason: "User interrupted the stream",
      }));
      const autoHandledSnapshot = [...autoHandledResults];
      const autoDeniedSnapshot = [...autoDeniedApprovals];
      const queuedResults = [
        ...autoHandledSnapshot.map((ar) => ({
          type: "tool" as const,
          tool_call_id: ar.toolCallId,
          tool_return: ar.result.toolReturn,
          status: ar.result.status,
          stdout: ar.result.stdout,
          stderr: ar.result.stderr,
        })),
        ...autoDeniedSnapshot.map((ad) => ({
          type: "approval" as const,
          tool_call_id: ad.approval.toolCallId,
          approve: false,
          reason: ad.reason,
        })),
        ...denialResults,
      ];
      if (queuedResults.length > 0) {
        queueApprovalResults(queuedResults);
      }

      // Clear local approval state
      setPendingApprovals([]);
      setApprovalContexts([]);
      setApprovalResults([]);
      setAutoHandledResults([]);
      setAutoDeniedApprovals([]);

      // Send cancel request to backend asynchronously (fire-and-forget)
      // Don't wait for it or show errors since user already got feedback
      Promise.resolve()
        .then(() => {
          const cancelConversationId =
            conversationIdRef.current === "default"
              ? agentIdRef.current
              : conversationIdRef.current;
          if (!cancelConversationId || cancelConversationId === "loading") {
            return;
          }
          return getBackend().cancelConversation(cancelConversationId);
        })
        .catch(() => {
          // Silently ignore - cancellation already happened client-side
        });

      // Reset cancellation flags after cleanup is complete.
      // Use setTimeout(50) instead of setTimeout(0) to ensure React has fully processed
      // the streaming=false state before we allow the dequeue effect to start a new conversation.
      // This prevents the "Maximum update depth exceeded" infinite render loop.
      setTimeout(() => {
        userCancelledRef.current = false;
        setInterruptRequested(false);
      }, 50);

      return;
    } else {
      setInterruptRequested(true);
      try {
        const cancelConversationId =
          conversationIdRef.current === "default"
            ? agentIdRef.current
            : conversationIdRef.current;
        if (!cancelConversationId || cancelConversationId === "loading") {
          return;
        }
        await getBackend().cancelConversation(cancelConversationId);

        if (abortControllerRef.current) {
          abortControllerRef.current.abort();
          abortControllerRef.current = null;
        }
        setIsExecutingTool(false);
        toolResultsInFlightRef.current = false;
        pendingInterruptRecoveryConversationIdRef.current =
          conversationIdRef.current;
      } catch (e) {
        const errorDetails = formatErrorDetails(e, agentId);
        appendError(`Failed to interrupt stream: ${errorDetails}`, {
          ...extractErrorMeta(e),
          context: "stream_interrupt",
        });
        setInterruptRequested(false);
        setIsExecutingTool(false);
        toolResultsInFlightRef.current = false;
      }
    }
  }, [
    agentId,
    streaming,
    interruptRequested,
    appendError,
    isExecutingTool,
    refreshDerived,
    setStreaming,
    pendingApprovals,
    autoHandledResults,
    autoDeniedApprovals,
    queueApprovalResults,
    resetTrajectoryBases,
  ]);

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

        // Fork the conversation
        const forked = await getBackend().forkConversation(
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
        let stream: Awaited<ReturnType<typeof sendMessageStream>>;

        while (true) {
          try {
            const preparedToolContext = await prepareScopedToolExecutionContext(
              tempModelOverrideRef.current ?? undefined,
            );
            stream = await sendMessageStream(forked.id, currentInput, {
              overrideModel: tempModelOverrideRef.current ?? undefined,
              preparedToolContext: preparedToolContext.preparedToolContext,
            });
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
    [agentId, prepareScopedToolExecutionContext],
  );

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

      await runEndHooks();

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

        pendingConversationSwitchRef.current = {
          origin: "fork",
          conversationId,
          isDefault: false,
          messageCount: resumeData.messageHistory.length,
          messageHistory: resumeData.messageHistory,
        };

        settingsManager.setLocalLastSession(
          { agentId, conversationId },
          process.cwd(),
        );
        settingsManager.setGlobalLastSession({ agentId, conversationId });

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
      setCommandRunning,
      setStreaming,
      recoverRestoredPendingApprovals,
      resetDeferredToolCallCommits,
      resetTrajectoryBases,
    ],
  );

  const handleAgentSelect = useCallback(
    async (
      targetAgentId: string,
      opts?: {
        profileName?: string;
        conversationId?: string;
        commandId?: string;
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
        });
        return;
      }

      // Lock input for async operation (set before any await to prevent queue processing)
      setCommandRunning(true);

      // Show loading indicator while switching
      const cmd =
        overlayCommand ?? commandRunner.start("/agents", "Switching agent...");
      cmd.update({ output: "Switching agent...", phase: "running" });

      try {
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

        // Ensure bootstrap reminders are re-injected on the first user turn
        // after switching to a different conversation/agent context.
        resetBootstrapReminderState();

        // Set conversation switch context for agent switch
        {
          const { getModelDisplayName } = await import("../../agent/model");
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
              `⎿  Conversation: ${opts.conversationId}`,
            ].join("\n")
          : [
              `Resumed the default conversation with **${agentLabel}**.`,
              `⎿  Type /resume to browse all conversations`,
              `⎿  Type /new to start a new conversation`,
            ].join("\n");
        const separator = {
          kind: "separator" as const,
          id: uid("sep"),
        };
        setStaticItems([separator]);
        cmd.finish(successOutput, true);
      } catch (error) {
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
    ],
  );

  // Handle creating a new agent and switching to it
  const handleCreateNewAgent = useCallback(
    async (name: string) => {
      // Close dialog immediately
      setActiveOverlay(null);

      // Lock input for async operation
      setCommandRunning(true);

      const inputCmd = "/new";
      const cmd = commandRunner.start(inputCmd, `Creating agent "${name}"...`);

      try {
        // Pre-determine memfs mode so the agent is created with the correct prompt.
        const { isLettaCloud, enableMemfsIfCloud } = await import(
          "../../agent/memoryFilesystem"
        );
        const backend = getBackend();
        const willAutoEnableMemfs = await isLettaCloud();

        let effectiveModel = currentModelId || currentModelHandle || undefined;
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
        const agentUrl = buildChatUrl(agent.id);
        const memfsTip =
          "Tip: use /init to initialize your agent's memory system!";
        const successOutput = [
          `Created **${agent.name || agent.id}** (use /pin to save)`,
          `⎿  ${agentUrl}`,
          `⎿  ${memfsTip}`,
        ].join("\n");
        cmd.finish(successOutput, true);
        const successItem: StaticItem = {
          kind: "command",
          id: cmd.id,
          input: cmd.input,
          output: successOutput,
          phase: "finished",
          success: true,
        };

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

        // Set conversation switch context for new agent switch
        pendingConversationSwitchRef.current = {
          origin: "agent-switch",
          conversationId: targetConversationId,
          isDefault: true,
          agentSwitchContext: {
            name: agent.name || agent.id,
            description: agent.description ?? undefined,
            model: agentModelHandle
              ? (await import("../../agent/model")).getModelDisplayName(
                  agentModelHandle,
                ) || agentModelHandle
              : "unknown",
            blockCount: agent.blocks?.length ?? 0,
          },
        };

        // Reset context token tracking for new agent
        resetContextHistory(contextTrackerRef.current);

        // Ensure bootstrap reminders are re-injected after creating a new agent.
        resetBootstrapReminderState();

        const separator = {
          kind: "separator" as const,
          id: uid("sep"),
        };

        setStaticItems([separator, successItem]);
        // Sync lines display after clearing buffers
        setLines(toLines(buffersRef.current));
      } catch (error) {
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
    ],
  );

  // Handle bash mode command submission
  // Expands aliases from shell config files, then runs with spawnCommand
  // Implements input locking and ESC cancellation (LET-7199)
  const handleBashSubmit = useCallback(
    async (command: string) => {
      // Input locking - prevent multiple concurrent bash commands
      if (bashRunning) return;

      const cmdId = uid("bash");
      const startTime = Date.now();

      // Set up state for input locking and cancellation
      setBashRunning(true);
      bashAbortControllerRef.current = new AbortController();

      // Add running bash_command line with streaming state
      buffersRef.current.byId.set(cmdId, {
        kind: "bash_command",
        id: cmdId,
        input: command,
        output: "",
        phase: "running",
        streaming: {
          tailLines: [],
          partialLine: "",
          partialIsStderr: false,
          totalLineCount: 0,
          startTime,
        },
      });
      buffersRef.current.order.push(cmdId);
      refreshDerived();

      try {
        // Expand aliases before running
        const { expandAliases } = await import("../helpers/shellAliases");
        const expanded = expandAliases(command);

        // If command uses a shell function, prepend the function definition
        const finalCommand = expanded.functionDef
          ? `${expanded.functionDef}\n${expanded.command}`
          : expanded.command;

        // Use spawnCommand for actual execution
        const { spawnCommand } = await import("../../tools/impl/Bash.js");
        const { getShellEnv } = await import("../../tools/impl/shellEnv.js");

        const result = await spawnCommand(finalCommand, {
          cwd: process.cwd(),
          env: getShellEnv(),
          timeout: 0, // No timeout - user must ESC to interrupt (LET-7199)
          signal: bashAbortControllerRef.current.signal,
          onOutput: (chunk, stream) => {
            const entry = buffersRef.current.byId.get(cmdId);
            if (entry && entry.kind === "bash_command") {
              const newStreaming = appendStreamingOutput(
                entry.streaming,
                chunk,
                startTime,
                stream === "stderr",
              );
              buffersRef.current.byId.set(cmdId, {
                ...entry,
                streaming: newStreaming,
              });
              refreshDerivedStreaming();
            }
          },
        });

        // Combine stdout and stderr for output
        const output = (result.stdout + result.stderr).trim();
        const success = result.exitCode === 0;

        // Update line with output, clear streaming state
        const displayOutput =
          output ||
          (success
            ? "(Command completed with no output)"
            : `Exit code: ${result.exitCode}`);
        buffersRef.current.byId.set(cmdId, {
          kind: "bash_command",
          id: cmdId,
          input: command,
          output: displayOutput,
          phase: "finished",
          success,
          streaming: undefined,
        });

        // Cache for next user message
        bashCommandCacheRef.current.push({
          input: command,
          output: displayOutput,
        });
      } catch (error: unknown) {
        // Check if this was an abort (user pressed ESC)
        const err = error as { name?: string; code?: string; message?: string };
        const isAbort =
          bashAbortControllerRef.current?.signal.aborted ||
          err.code === "ABORT_ERR" ||
          err.name === "AbortError" ||
          err.message === "The operation was aborted";

        let errOutput: string;
        if (isAbort) {
          errOutput = INTERRUPTED_BY_USER;
        } else {
          // Handle command errors (timeout, other failures)
          errOutput =
            error instanceof Error
              ? (error as { stderr?: string; stdout?: string }).stderr ||
                (error as { stdout?: string }).stdout ||
                error.message
              : String(error);
        }

        buffersRef.current.byId.set(cmdId, {
          kind: "bash_command",
          id: cmdId,
          input: command,
          output: errOutput,
          phase: "finished",
          success: false,
          streaming: undefined,
        });

        // Still cache for next user message (even failures are visible to agent)
        bashCommandCacheRef.current.push({ input: command, output: errOutput });
      } finally {
        // Clean up state
        setBashRunning(false);
        bashAbortControllerRef.current = null;
      }

      refreshDerived();
    },
    [bashRunning, refreshDerived, refreshDerivedStreaming],
  );

  // Handle ESC interrupt for bash mode commands (LET-7199)
  const handleBashInterrupt = useCallback(() => {
    if (bashAbortControllerRef.current) {
      bashAbortControllerRef.current.abort();
    }
  }, []);

  /**
   * Check and handle any pending approvals before sending a slash command.
   * Returns true if approvals need user input (caller should return { submitted: false }).
   * Returns false if no approvals or all auto-handled (caller can proceed).
   */
  const checkPendingApprovalsForSlashCommand = useCallback(async (): Promise<
    { blocked: true } | { blocked: false }
  > => {
    // Only check eagerly when resuming a session (LET-7101)
    if (!needsEagerApprovalCheck) {
      return { blocked: false };
    }

    const queuedMetadata = queuedApprovalMetadataRef.current;
    const hasQueuedRealResults =
      queuedApprovalResultsRef.current !== null &&
      queuedApprovalResultsRef.current.length > 0 &&
      queuedMetadata?.conversationId === conversationIdRef.current &&
      queuedMetadata.generation === conversationGenerationRef.current;
    if (hasQueuedRealResults) {
      setNeedsEagerApprovalCheck(false);
      return { blocked: false };
    }

    try {
      const agent = await getBackend().retrieveAgent(agentId);
      const { pendingApprovals: existingApprovals } =
        await getResumeDataFromBackend(agent, conversationIdRef.current);

      if (!existingApprovals || existingApprovals.length === 0) {
        setNeedsEagerApprovalCheck(false);
        return { blocked: false };
      }

      const staleDenials = buildFreshDenialApprovals(
        existingApprovals,
        STALE_APPROVAL_RECOVERY_DENIAL_REASON,
      ) as ApprovalResult[];
      if (staleDenials.length > 0) {
        queueApprovalResults(staleDenials, {
          conversationId: conversationIdRef.current,
          generation: conversationGenerationRef.current,
        });
        setNeedsEagerApprovalCheck(false);
      }

      return { blocked: false };
    } catch {
      // If check fails, proceed anyway (don't block user)
      return { blocked: false };
    }
  }, [agentId, needsEagerApprovalCheck, queueApprovalResults]);

  const consumeQueuedApprovalInputForCurrentConversation = useCallback(
    (otid: string = createClientOtid()): ApprovalCreate | null => {
      const queuedResults = queuedApprovalResultsRef.current;
      if (!queuedResults || queuedResults.length === 0) {
        return null;
      }

      const queuedMetadata = queuedApprovalMetadataRef.current;
      const isQueuedValid =
        queuedMetadata &&
        queuedMetadata.conversationId === conversationIdRef.current &&
        queuedMetadata.generation === conversationGenerationRef.current;

      queueApprovalResults(null);
      interruptQueuedRef.current = false;

      if (!isQueuedValid) {
        debugWarn(
          "queue",
          "Dropping stale queued approval results for mismatched conversation or generation",
        );
        return null;
      }

      return {
        type: "approval",
        approvals: queuedResults,
        otid,
      };
    },
    [queueApprovalResults],
  );

  const processConversationWithQueuedApprovals = useCallback(
    async (
      input: Array<MessageCreate | ApprovalCreate>,
      options?: Parameters<typeof processConversation>[1],
    ): Promise<void> => {
      const queuedApprovalInput =
        consumeQueuedApprovalInputForCurrentConversation();
      const nextInput = queuedApprovalInput
        ? [queuedApprovalInput, ...input]
        : input;
      await processConversation(nextInput, options);
    },
    [consumeQueuedApprovalInputForCurrentConversation, processConversation],
  );

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
    cacheLastPlanFilePath,
    checkPendingApprovalsForSlashCommand,
    chromeColumns,
    commandRunner,
    commandRunning,
    consumeQueuedApprovalInputForCurrentConversation,
    contextTrackerRef,
    conversationGenerationRef,
    conversationId,
    conversationIdRef,
    currentModelDisplay,
    currentModelHandle,
    currentModelId,
    currentModelLabel,
    currentModelProvider,
    currentReasoningEffort,
    currentSystemPromptId,
    currentToolset,
    effectiveContextWindowSize,
    emittedIdsRef,
    firstUserQueryRef,
    flushPendingReasoningEffort: () => flushPendingReasoningEffort(),
    generateConversationTitle,
    handleAgentSelect,
    handleBtwCommand,
    handleExit,
    hasBackfilledRef,
    isAgentBusy,
    isExecutingTool,
    lastRunIdRef,
    llmConfigRef,
    maybeCarryOverActiveConversationModel,
    needsEagerApprovalCheck,
    networkPhase,
    openTrajectorySegment,
    overrideContentPartsRef,
    pendingApprovals,
    pendingConversationSwitchRef,
    pendingGitReminderRef,
    pendingRalphConfig,
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
    setActiveOverlay,
    setAgentDescription,
    setAgentState,
    setCommandRunning,
    setConversationAutoTitleEligibility,
    setConversationIdAndRef,
    setConversationOverrideContextWindowLimit,
    setConversationOverrideModelSettings,
    setCurrentPersonalityId,
    setDequeueEpoch,
    setFeedbackPrefill,
    setHasConversationModelOverride,
    setLines,
    setLlmConfig,
    setModelSelectorOptions,
    setNeedsEagerApprovalCheck,
    setPendingRalphConfig,
    setPinDialogLocal,
    setProfileConfirmPending,
    setReasoningTabCycleEnabled: _setReasoningTabCycleEnabled,
    setSearchQuery,
    setStaticItems,
    setStaticRenderEpoch,
    setStreaming,
    setThinkingMessage,
    setTokenStreamingEnabled,
    setTrajectoryTokenBase,
    setUiPermissionMode,
    setUiRalphActive,
    sharedReminderStateRef,
    shouldAutoGenerateConversationTitleRef,
    startOverlayCommand,
    streaming,
    systemInfoReminderEnabled,
    systemPromptRecompileByConversationRef:
      _systemPromptRecompileByConversationRef,
    tokenStreamingEnabled,
    trajectoryRunTokenStartRef,
    trajectoryTokenDisplayRef,
    triggerStatusLineRefresh,
    tuiQueueRef,
    uiPermissionMode,
    updateAgentName,
    updateMemorySyncCommand,
    userCancelledRef,
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
      !anySelectorOpen && // Don't dequeue while a selector/overlay is open
      !waitingForQueueCancelRef.current && // Don't dequeue while waiting for cancel
      !userCancelledRef.current && // Don't dequeue if user just cancelled
      !abortControllerRef.current && // Don't dequeue while processConversation is still active
      !dequeueInFlightRef.current // Don't dequeue while previous dequeue submit is still in flight
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
    anySelectorOpen,
    dequeueEpoch,
    queuedOverlayAction,
  ]);

  // Helper to send all approval results when done
  const sendAllResults = useCallback(
    async (
      additionalDecision?:
        | { type: "approve"; approval: ApprovalRequest }
        | { type: "deny"; approval: ApprovalRequest; reason: string },
    ) => {
      try {
        // Don't send results if user has already cancelled
        if (
          userCancelledRef.current ||
          abortControllerRef.current?.signal.aborted
        ) {
          setStreaming(false);
          setIsExecutingTool(false);
          setPendingApprovals([]);
          setApprovalContexts([]);
          setApprovalResults([]);
          setAutoHandledResults([]);
          setAutoDeniedApprovals([]);
          return;
        }

        // Snapshot current state before clearing dialog
        const approvalResultsSnapshot = [...approvalResults];
        const autoHandledSnapshot = [...autoHandledResults];
        const autoDeniedSnapshot = [...autoDeniedApprovals];
        const pendingSnapshot = [...pendingApprovals];

        // Clear dialog state immediately so UI updates right away
        setPendingApprovals([]);
        setApprovalContexts([]);
        setApprovalResults([]);
        setAutoHandledResults([]);
        setAutoDeniedApprovals([]);

        // Show "thinking" state and lock input while executing approved tools client-side
        setStreaming(true);
        openTrajectorySegment();
        // Ensure interrupted flag is cleared for this execution
        buffersRef.current.interrupted = false;

        const approvalAbortController = new AbortController();
        toolAbortControllerRef.current = approvalAbortController;

        // Combine all decisions using snapshots
        const allDecisions = [
          ...approvalResultsSnapshot,
          ...(additionalDecision ? [additionalDecision] : []),
        ];

        const approvedDecisions = allDecisions.filter(
          (
            decision,
          ): decision is {
            type: "approve";
            approval: ApprovalRequest;
            precomputedResult?: ToolExecutionResult;
          } => decision.type === "approve",
        );
        const runningDecisions = approvedDecisions.filter(
          (decision) => !decision.precomputedResult,
        );

        executingToolCallIdsRef.current = runningDecisions.map(
          (decision) => decision.approval.toolCallId,
        );

        // Set phase to "running" for all approved tools
        if (runningDecisions.length > 0) {
          setToolCallsRunning(
            buffersRef.current,
            runningDecisions.map((d) => d.approval.toolCallId),
          );
        }
        refreshDerived();

        // Execute approved tools and format results using shared function
        const { executeApprovalBatch } = await import(
          "../../agent/approval-execution"
        );
        sessionStatsRef.current.startTrajectory();
        const toolRunStart = performance.now();
        let executedResults: Awaited<ReturnType<typeof executeApprovalBatch>>;
        try {
          const approvalToolContextId =
            approvalToolContextIdRef.current ??
            (
              await prepareScopedToolExecutionContext(
                tempModelOverrideRef.current ?? undefined,
              )
            ).preparedToolContext.contextId;
          executedResults = await executeApprovalBatch(
            allDecisions,
            (chunk) => {
              onChunk(buffersRef.current, chunk);
              // Also log errors to the UI error display
              if (
                chunk.status === "error" &&
                chunk.message_type === "tool_return_message"
              ) {
                const isToolError = chunk.tool_return?.startsWith(
                  "Error executing tool:",
                );
                if (isToolError) {
                  appendError(chunk.tool_return, {
                    errorType: "tool_execution_error",
                    context: "tool_execution",
                  });
                }
              }
              // Flush UI so completed tools show up while the batch continues
              refreshDerived();
            },
            {
              abortSignal: approvalAbortController.signal,
              onStreamingOutput: updateStreamingOutput,
              toolContextId: approvalToolContextId,
            },
          );
        } finally {
          const toolRunMs = performance.now() - toolRunStart;
          sessionStatsRef.current.accumulateTrajectory({
            localToolMs: toolRunMs,
          });
        }

        // Combine with auto-handled and auto-denied results using snapshots
        const allResults = [
          ...autoHandledSnapshot.map((ar) => ({
            type: "tool" as const,
            tool_call_id: ar.toolCallId,
            tool_return: ar.result.toolReturn,
            status: ar.result.status,
            stdout: ar.result.stdout,
            stderr: ar.result.stderr,
          })),
          ...autoDeniedSnapshot.map((ad) => ({
            type: "approval" as const,
            tool_call_id: ad.approval.toolCallId,
            approve: false,
            reason: ad.reason,
          })),
          ...executedResults,
        ];

        // Dev-only validation: ensure outgoing IDs match expected IDs (using snapshots)
        if (process.env.NODE_ENV !== "production") {
          // Include ALL tool call IDs: auto-handled, auto-denied, and pending approvals
          const expectedIds = new Set([
            ...autoHandledSnapshot.map((ar) => ar.toolCallId),
            ...autoDeniedSnapshot.map((ad) => ad.approval.toolCallId),
            ...pendingSnapshot.map((a) => a.toolCallId),
          ]);
          const sendingIds = new Set(
            allResults.map((r) => r.tool_call_id).filter(Boolean),
          );

          const setsEqual = (a: Set<string>, b: Set<string>) =>
            a.size === b.size && [...a].every((id) => b.has(id));

          if (!setsEqual(expectedIds, sendingIds)) {
            debugLog(
              "approvals",
              "[BUG] Approval ID mismatch detected. Expected: %O, Sending: %O",
              Array.from(expectedIds),
              Array.from(sendingIds),
            );
            throw new Error(
              "Approval ID mismatch - refusing to send mismatched IDs",
            );
          }
        }

        // Rotate to a new thinking message
        setThinkingMessage(getRandomThinkingVerb());
        refreshDerived();

        const wasAborted = approvalAbortController.signal.aborted;
        // Check if user cancelled via ESC. We use wasAborted (toolAbortController was aborted)
        // as the primary signal, plus userCancelledRef for cancellations that happen just before
        // tools complete. Note: we can't use `abortControllerRef.current === null` because
        // abortControllerRef is also null in the normal approval flow (no stream running).
        const userCancelled = userCancelledRef.current;

        if (wasAborted || userCancelled) {
          // Queue results to send alongside the next user message so the backend
          // doesn't keep requesting the same approvals after an interrupt.
          if (!interruptQueuedRef.current) {
            queueApprovalResults(allResults as ApprovalResult[]);
          }
          setStreaming(false);
          closeTrajectorySegment();
          syncTrajectoryElapsedBase();

          // Reset queue-cancel flag so dequeue effect can fire
          waitingForQueueCancelRef.current = false;
          queueSnapshotRef.current = [];
        } else {
          const queuedItemsToAppend = consumeQueuedMessages();
          const queuedNotifications = queuedItemsToAppend
            ? getQueuedNotificationSummaries(queuedItemsToAppend)
            : [];
          const hadNotifications =
            appendTaskNotificationEvents(queuedNotifications);
          const input: Array<MessageCreate | ApprovalCreate> = [
            {
              type: "approval",
              approvals: allResults as ApprovalResult[],
              otid: createClientOtid(),
            },
          ];
          if (queuedItemsToAppend && queuedItemsToAppend.length > 0) {
            const queuedUserText = buildQueuedUserText(queuedItemsToAppend);
            const queuedUserOtid = createClientOtid();
            appendOptimisticUserLine(
              buffersRef.current,
              queuedUserText,
              queuedUserOtid,
            );
            input.push({
              type: "message",
              role: "user",
              content: buildQueuedContentParts(queuedItemsToAppend),
              otid: queuedUserOtid,
            });
            refreshDerived();
          } else if (hadNotifications) {
            refreshDerived();
          }
          // Flush finished items synchronously before reentry. This avoids a
          // race where deferred non-Task commits delay Task grouping while the
          // reentry path continues.
          flushEligibleLinesBeforeReentry(
            commitEligibleLines,
            buffersRef.current,
          );
          toolResultsInFlightRef.current = true;
          await processConversation(input, { allowReentry: true });
          toolResultsInFlightRef.current = false;

          // Clear any stale queued results from previous interrupts.
          // This approval flow supersedes any previously queued results - if we don't
          // clear them here, they persist with matching generation and get sent on the
          // next onSubmit, causing "Invalid tool call IDs" errors.
          queueApprovalResults(null);
        }
      } finally {
        // Always release the execution guard, even if an error occurred
        clearApprovalToolContext();
        setIsExecutingTool(false);
        toolAbortControllerRef.current = null;
        executingToolCallIdsRef.current = [];
        interruptQueuedRef.current = false;
        toolResultsInFlightRef.current = false;
      }
    },
    [
      approvalResults,
      autoHandledResults,
      autoDeniedApprovals,
      pendingApprovals,
      processConversation,
      refreshDerived,
      appendError,
      setStreaming,
      updateStreamingOutput,
      queueApprovalResults,
      consumeQueuedMessages,
      appendTaskNotificationEvents,
      clearApprovalToolContext,
      syncTrajectoryElapsedBase,
      closeTrajectorySegment,
      openTrajectorySegment,
      commitEligibleLines,
      prepareScopedToolExecutionContext,
    ],
  );

  // Handle approval callbacks - sequential review
  const handleApproveCurrent = useCallback(
    async (diffs?: Map<string, AdvancedDiffSuccess>) => {
      if (isExecutingTool) return;

      const currentIndex = approvalResults.length;
      const currentApproval = pendingApprovals[currentIndex];

      if (!currentApproval) return;

      // Store precomputed diffs before execution
      if (diffs) {
        for (const [key, diff] of diffs) {
          precomputedDiffsRef.current.set(key, diff);
        }
      }

      setIsExecutingTool(true);

      try {
        // Store approval decision (don't execute yet - batch execute after all approvals)
        const decision = {
          type: "approve" as const,
          approval: currentApproval,
        };

        // Check if we're done with all approvals
        if (currentIndex + 1 >= pendingApprovals.length) {
          // All approvals collected, execute and send to backend
          // sendAllResults owns the lock release via its finally block
          await sendAllResults(decision);
        } else {
          // Not done yet, store decision and show next approval
          setApprovalResults((prev) => [...prev, decision]);
          setIsExecutingTool(false);
        }
      } catch (e) {
        const errorDetails = formatErrorDetails(e, agentId);
        appendError(errorDetails, {
          ...extractErrorMeta(e),
          context: "approval_send",
        });
        setStreaming(false);
        setIsExecutingTool(false);
      }
    },
    [
      agentId,
      pendingApprovals,
      approvalResults,
      sendAllResults,
      appendError,
      isExecutingTool,
      setStreaming,
    ],
  );

  const handleApproveAlways = useCallback(
    async (
      scope?: "project" | "session",
      diffs?: Map<string, AdvancedDiffSuccess>,
    ) => {
      if (isExecutingTool) return;

      if (pendingApprovals.length === 0 || approvalContexts.length === 0)
        return;

      const currentIndex = approvalResults.length;
      const approvalContext = approvalContexts[currentIndex];
      const currentApproval = pendingApprovals[currentIndex];
      if (!approvalContext || !currentApproval) return;

      const parsedArgs = safeJsonParseOr<Record<string, unknown>>(
        currentApproval.toolArgs,
        {},
      );
      const latestApprovalContext = await analyzeToolApproval(
        currentApproval.toolName,
        parsedArgs,
      );
      const rule = latestApprovalContext.recommendedRule;
      const actualScope = scope || latestApprovalContext.defaultScope;

      if (!latestApprovalContext.allowPersistence || !rule) {
        commandRunner
          .start("/approve-always", "Adding permission...")
          .fail("This approval cannot be persisted.");
        return;
      }

      const cmd = commandRunner.start(
        "/approve-always",
        "Adding permission...",
      );

      if (rule === "Edit(**)" && actualScope === "session") {
        setUiPermissionMode("acceptEdits");
        cmd.finish("Permission mode set to acceptEdits (session only)", true);
      } else {
        // Save the permission rule
        try {
          await savePermissionRule(rule, "allow", actualScope);
        } catch (error) {
          const errorDetails = formatErrorDetails(error, agentId);
          cmd.fail(`Failed to add permission: ${errorDetails}`);
          return;
        }

        // Show confirmation in transcript
        const scopeText =
          actualScope === "session" ? " (session only)" : " (project)";
        cmd.finish(`Added permission: ${rule}${scopeText}`, true);
      }

      // Re-check remaining approvals against the newly saved permission
      // This allows subsequent approvals that match the new rule to be auto-allowed
      const remainingApprovals = pendingApprovals.slice(currentIndex + 1);
      if (remainingApprovals.length > 0) {
        const recheckResults = await Promise.all(
          remainingApprovals.map(async (approval) => {
            const parsedArgs = safeJsonParseOr<Record<string, unknown>>(
              approval.toolArgs,
              {},
            );
            const permission = await checkToolPermission(
              approval.toolName,
              parsedArgs,
            );
            return { approval, permission };
          }),
        );

        const nowAutoAllowed = recheckResults.filter(
          (r) => r.permission.decision === "allow",
        );
        const stillNeedAsking = recheckResults.filter(
          (r) => r.permission.decision === "ask",
        );

        // Only auto-handle if ALL remaining are now allowed
        // (avoids complex state synchronization issues with partial batches)
        if (stillNeedAsking.length === 0 && nowAutoAllowed.length > 0) {
          const currentApproval = pendingApprovals[currentIndex];
          if (!currentApproval) return;

          // Store diffs before execution
          if (diffs) {
            for (const [key, diff] of diffs) {
              precomputedDiffsRef.current.set(key, diff);
            }
          }

          setIsExecutingTool(true);

          // Snapshot current state BEFORE clearing (critical for ID matching!)
          // This must include ALL previous decisions, auto-handled, and auto-denied
          const approvalResultsSnapshot = [...approvalResults];
          const autoHandledSnapshot = [...autoHandledResults];
          const autoDeniedSnapshot = [...autoDeniedApprovals];

          // Build ALL decisions: previous + current + auto-allowed remaining
          const allDecisions: Array<
            | { type: "approve"; approval: ApprovalRequest }
            | { type: "deny"; approval: ApprovalRequest; reason: string }
          > = [
            ...approvalResultsSnapshot, // Include decisions from previous rounds
            { type: "approve", approval: currentApproval },
            ...nowAutoAllowed.map((r) => ({
              type: "approve" as const,
              approval: r.approval,
            })),
          ];

          // Clear dialog state immediately
          setPendingApprovals([]);
          setApprovalContexts([]);
          setApprovalResults([]);
          setAutoHandledResults([]);
          setAutoDeniedApprovals([]);

          setStreaming(true);
          openTrajectorySegment();
          buffersRef.current.interrupted = false;

          // Set phase to "running" for all approved tools
          setToolCallsRunning(
            buffersRef.current,
            allDecisions
              .filter((d) => d.type === "approve")
              .map((d) => d.approval.toolCallId),
          );
          refreshDerived();

          try {
            // Execute ALL decisions together
            const { executeApprovalBatch } = await import(
              "../../agent/approval-execution"
            );
            const approvalToolContextId =
              approvalToolContextIdRef.current ??
              (
                await prepareScopedToolExecutionContext(
                  tempModelOverrideRef.current ?? undefined,
                )
              ).preparedToolContext.contextId;
            const executedResults = await executeApprovalBatch(
              allDecisions,
              (chunk) => {
                onChunk(buffersRef.current, chunk);
                refreshDerived();
              },
              {
                onStreamingOutput: updateStreamingOutput,
                toolContextId: approvalToolContextId,
              },
            );

            // Combine with auto-handled and auto-denied results (from initial check)
            const allResults = [
              ...autoHandledSnapshot.map((ar) => ({
                type: "tool" as const,
                tool_call_id: ar.toolCallId,
                tool_return: ar.result.toolReturn,
                status: ar.result.status,
                stdout: ar.result.stdout,
                stderr: ar.result.stderr,
              })),
              ...autoDeniedSnapshot.map((ad) => ({
                type: "approval" as const,
                tool_call_id: ad.approval.toolCallId,
                approve: false,
                reason: ad.reason,
              })),
              ...executedResults,
            ];

            setThinkingMessage(getRandomThinkingVerb());
            refreshDerived();

            // Continue conversation with all results
            await processConversation([
              {
                type: "approval",
                approvals: allResults as ApprovalResult[],
                otid: randomUUID(),
              },
            ]);
          } finally {
            setIsExecutingTool(false);
          }
          return; // Don't call handleApproveCurrent - we handled everything
        }
      }

      // Fallback: proceed with normal flow (will prompt for remaining approvals)
      await handleApproveCurrent(diffs);
    },
    [
      agentId,
      commandRunner,
      approvalResults,
      approvalContexts,
      pendingApprovals,
      autoHandledResults,
      autoDeniedApprovals,
      handleApproveCurrent,
      processConversation,
      refreshDerived,
      isExecutingTool,
      setStreaming,
      setUiPermissionMode,
      openTrajectorySegment,
      prepareScopedToolExecutionContext,
      updateStreamingOutput,
    ],
  );

  const handleDenyCurrent = useCallback(
    async (reason: string) => {
      if (isExecutingTool) return;

      const currentIndex = approvalResults.length;
      const currentApproval = pendingApprovals[currentIndex];

      if (!currentApproval) return;

      setIsExecutingTool(true);

      try {
        // Store denial decision
        const decision = {
          type: "deny" as const,
          approval: currentApproval,
          reason: reason || "User denied the tool execution",
        };

        // Check if we're done with all approvals
        if (currentIndex + 1 >= pendingApprovals.length) {
          // All approvals collected, execute and send to backend
          // sendAllResults owns the lock release via its finally block
          setThinkingMessage(getRandomThinkingVerb());
          await sendAllResults(decision);
        } else {
          // Not done yet, store decision and show next approval
          setApprovalResults((prev) => [...prev, decision]);
          setIsExecutingTool(false);
        }
      } catch (e) {
        const errorDetails = formatErrorDetails(e, agentId);
        appendError(errorDetails, {
          ...extractErrorMeta(e),
          context: "approval_send",
        });
        setStreaming(false);
        setIsExecutingTool(false);
      }
    },
    [
      agentId,
      pendingApprovals,
      approvalResults,
      sendAllResults,
      appendError,
      isExecutingTool,
      setStreaming,
    ],
  );

  // Cancel all pending approvals - queue denials to send with next message
  // Similar to interrupt flow during tool execution
  const handleCancelApprovals = useCallback(() => {
    if (pendingApprovals.length === 0) return;

    // Create denial results for all pending approvals and queue for next message
    const denialResults = pendingApprovals.map((approval) => ({
      type: "approval" as const,
      tool_call_id: approval.toolCallId,
      approve: false,
      reason: "User cancelled the approval",
    }));
    queueApprovalResults(denialResults);

    // Mark the pending approval tool calls as cancelled in the buffers
    markIncompleteToolsAsCancelled(buffersRef.current, true, "approval_cancel");
    refreshDerived();

    // Clear all approval state
    setPendingApprovals([]);
    setApprovalContexts([]);
    setApprovalResults([]);
    setAutoHandledResults([]);
    setAutoDeniedApprovals([]);
  }, [pendingApprovals, refreshDerived, queueApprovalResults]);
  const {
    handleModelSelect,
    handleSystemPromptSelect,
    handlePersonalitySelect,
    handleSleeptimeModeSelect,
    handleCompactionModeSelect,
    handleToolsetSelect,
    handleExperimentSelect,
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
        handleAgentSelect(action.agentId, { commandId: action.commandId });
      } else if (action.type === "switch_model") {
        // Call handleModelSelect - it will see isAgentBusy() as false now
        handleModelSelect(action.modelId, action.commandId);
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
  const handleFeedbackSubmit = useCallback(
    async (message: string) => {
      // Consume command handle BEFORE closing overlay; otherwise closeOverlay()
      // finishes it as "Feedback dialog dismissed" and we emit a duplicate entry.
      const overlayCommand = consumeOverlayCommand("feedback");
      closeOverlay();

      await withCommandLock(async () => {
        const cmd =
          overlayCommand ??
          commandRunner.start("/feedback", "Sending feedback...");

        try {
          const resolvedMessage = resolvePlaceholders(message);

          cmd.update({
            output: "Sending feedback...",
            phase: "running",
          });

          const settings = settingsManager.getSettings();
          const apiKey =
            process.env.LETTA_API_KEY || settings.env?.LETTA_API_KEY;

          // Only send anonymized, safe settings for debugging
          const {
            env: _env,
            refreshToken: _refreshToken,
            ...safeSettings
          } = settings;

          await submitFeedbackMetadata(
            apiKey,
            settingsManager.getOrCreateDeviceId(),
            {
              message: resolvedMessage,
              feature: "letta-code",
              agent_id: agentId,
              session_id: telemetry.getSessionId(),
              version: getVersion(),
              platform: process.platform,
              settings: JSON.stringify(safeSettings),
              // System info
              local_time: getLocalTime(),
              device_type: getDeviceType(),
              cwd: process.cwd(),
              // Session stats
              ...(() => {
                const stats = sessionStatsRef.current?.getSnapshot();
                if (!stats) return {};
                return {
                  total_api_ms: stats.totalApiMs,
                  total_wall_ms: stats.totalWallMs,
                  step_count: stats.usage.stepCount,
                  prompt_tokens: stats.usage.promptTokens,
                  completion_tokens: stats.usage.completionTokens,
                  total_tokens: stats.usage.totalTokens,
                  cached_input_tokens: stats.usage.cachedInputTokens,
                  cache_write_tokens: stats.usage.cacheWriteTokens,
                  reasoning_tokens: stats.usage.reasoningTokens,
                  context_tokens: stats.usage.contextTokens,
                };
              })(),
              // Agent info
              agent_name: agentName ?? undefined,
              agent_description: agentDescription ?? undefined,
              model: currentModelId ?? undefined,
              // Account info
              billing_tier: billingTier ?? undefined,
              server_version: telemetry.getServerVersion() ?? undefined,
              // Recent chunk log for diagnostics
              recent_chunks: chunkLog.getEntries(),
              // Debug log tail for diagnostics
              debug_log_tail: debugLogFile.getTail(),
            },
          );

          cmd.finish(
            "Feedback submitted! To chat with the Letta dev team live, join our Discord (https://discord.gg/letta).",
            true,
          );
        } catch (error) {
          const errorDetails = formatErrorDetails(error, agentId);
          cmd.fail(`Failed to send feedback: ${errorDetails}`);
        }
      });
    },
    [
      agentId,
      agentName,
      agentDescription,
      currentModelId,
      billingTier,
      commandRunner,
      consumeOverlayCommand,
      withCommandLock,
      closeOverlay,
    ],
  );

  const handleProfileEscapeCancel = useCallback(() => {
    if (profileConfirmPending) {
      const { cmdId, name } = profileConfirmPending;
      const cmd = commandRunner.getHandle(cmdId, `/profile load ${name}`);
      cmd.fail("Cancelled");
      setProfileConfirmPending(null);
    }
  }, [commandRunner, profileConfirmPending]);

  // Handle ralph mode exit from Input component (shift+tab)
  const handleRalphExit = useCallback(() => {
    const ralph = ralphMode.getState();
    if (ralph.isActive) {
      const wasYolo = ralph.isYolo;
      ralphMode.deactivate();
      setUiRalphActive(false);
      if (wasYolo) {
        permissionMode.setMode("default");
        setUiPermissionMode("default");
      }
    }
  }, [setUiPermissionMode]);

  // Handle permission mode changes from the Input component (e.g., shift+tab cycling)
  const handlePermissionModeChange = useCallback(
    (mode: PermissionMode) => {
      // When entering plan mode via tab cycling, generate and set the plan file path
      if (mode === "plan") {
        const planPath = generatePlanFilePath();
        permissionMode.setPlanFilePath(planPath);
        cacheLastPlanFilePath(planPath);
      }
      // permissionMode.setMode() is called in InputRich.tsx before this callback
      setUiPermissionMode(mode);
      triggerStatusLineRefresh();
    },
    [triggerStatusLineRefresh, setUiPermissionMode, cacheLastPlanFilePath],
  );

  // Reasoning tier cycling (Tab hotkey in InputRich.tsx)
  //
  // We update the footer immediately (optimistic local state) and debounce the
  // actual server update so users can rapidly cycle tiers.

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
          let conversationModelSettings:
            | AgentState["model_settings"]
            | null
            | undefined;
          let conversationContextWindowLimit: number | null | undefined;
          let updatedAgent: AgentState | null = null;
          if (isDefaultConversation) {
            const { updateAgentLLMConfig } = await import("../../agent/modify");
            updatedAgent = await updateAgentLLMConfig(
              agentIdRef.current,
              desired.modelHandle,
              {
                reasoning_effort: desired.effort,
              },
            );
          } else {
            const { updateConversationLLMConfig } = await import(
              "../../agent/modify"
            );
            const updatedConversation = await updateConversationLLMConfig(
              conversationIdRef.current,
              desired.modelHandle,
              {
                reasoning_effort: desired.effort,
              },
              { preserveContextWindow: true },
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
            ...mapHandleToLlmConfigPatch(desired.modelHandle),
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

            const { getModelInfo } = await import("../../agent/model");
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
  ]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refs are stable objects, .current is read dynamically
  const handleCycleReasoningEffort = useCallback(() => {
    void (async () => {
      if (!agentId) return;
      if (reasoningCycleInFlightRef.current) return;

      const current = llmConfigRef.current;
      // For ChatGPT OAuth sessions, llm_config may report model_endpoint_type as
      // "chatgpt_oauth" while our code/model registry uses the provider name
      // "chatgpt-plus-pro" in handles.
      const modelHandle =
        current?.model_endpoint_type && current?.model
          ? `${
              current.model_endpoint_type === "chatgpt_oauth"
                ? OPENAI_CODEX_PROVIDER_NAME
                : current.model_endpoint_type
            }/${current.model}`
          : current?.model;
      if (!modelHandle) return;

      // Derive current effort from effective model settings (conversation override aware)
      const modelSettingsForEffort = hasConversationModelOverrideRef.current
        ? undefined
        : agentStateRef.current?.model_settings;
      const currentEffort =
        deriveReasoningEffort(modelSettingsForEffort, current) ?? "none";

      const { models } = await import("../../agent/model");
      const tiers = models
        .filter((m) => m.handle === modelHandle)
        .map((m) => {
          const effort = (
            m.updateArgs as { reasoning_effort?: unknown } | undefined
          )?.reasoning_effort;
          return {
            id: m.id,
            effort: typeof effort === "string" ? effort : null,
          };
        })
        .filter((m): m is { id: string; effort: string } => Boolean(m.effort));

      // Only enable cycling when there are multiple tiers for the same handle.
      if (tiers.length < 2) return;

      const anthropicXHighEffort = modelHandle.includes("claude-opus-4-7")
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

      // Snapshot the last confirmed config once per burst so we can revert on failure.
      if (!reasoningCycleLastConfirmedRef.current) {
        reasoningCycleLastConfirmedRef.current = current ?? null;
        reasoningCycleLastConfirmedAgentStateRef.current =
          hasConversationModelOverrideRef.current
            ? null
            : (agentStateRef.current ?? null);
      }

      // Optimistic UI update (footer changes immediately).
      setLlmConfig((prev) =>
        prev ? ({ ...prev, reasoning_effort: next.effort } as LlmConfig) : prev,
      );
      // Patch agentState.model_settings only when operating on agent defaults.
      if (!hasConversationModelOverrideRef.current) {
        reasoningCyclePatchedAgentStateRef.current = true;
        setAgentState((prev) => {
          if (!prev) return prev ?? null;
          const ms = prev.model_settings;
          if (!ms || !("provider_type" in ms)) return prev;
          if (ms.provider_type === "openai") {
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
                    | "xhigh",
                },
              },
            } as AgentState;
          }
          if (
            ms.provider_type === "anthropic" ||
            ms.provider_type === "bedrock"
          ) {
            // "xhigh" is only distinct on Opus 4.7; older Anthropic models map it to backend "max".
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

  const handlePlanApprove = useCallback(
    async (acceptEdits: boolean = false) => {
      const currentIndex = approvalResults.length;
      const approval = pendingApprovals[currentIndex];
      if (!approval) return;

      const isLast = currentIndex + 1 >= pendingApprovals.length;

      // Capture plan file path BEFORE exiting plan mode (for post-approval rendering)
      const planFilePath =
        permissionMode.getPlanFilePath() ?? lastPlanFilePathRef.current;
      if (planFilePath) {
        lastPlanFilePathRef.current = planFilePath;
      }

      // Exit plan mode — if user already cycled out (e.g., Shift+Tab to
      // acceptEdits/yolo), keep their chosen mode instead of downgrading.
      const currentMode = permissionMode.getMode();
      if (currentMode === "plan") {
        const previousMode = permissionMode.getModeBeforePlan();
        const restoreMode =
          // If the user was in YOLO before entering plan mode, always restore it.
          previousMode === "bypassPermissions"
            ? "bypassPermissions"
            : acceptEdits
              ? "acceptEdits"
              : previousMode === "memory"
                ? "default"
                : (previousMode ?? "default");
        permissionMode.setMode(restoreMode);
        setUiPermissionMode(restoreMode);
      } else {
        setUiPermissionMode(currentMode);
      }

      try {
        // Execute ExitPlanMode tool to get the result
        const parsedArgs = safeJsonParseOr<Record<string, unknown>>(
          approval.toolArgs,
          {},
        );
        const toolResult = await executeTool("ExitPlanMode", parsedArgs);

        // Update buffers with tool return
        onChunk(buffersRef.current, {
          message_type: "tool_return_message",
          id: "dummy",
          date: new Date().toISOString(),
          tool_call_id: approval.toolCallId,
          tool_return: getDisplayableToolReturn(toolResult.toolReturn),
          status: toolResult.status,
          stdout: toolResult.stdout,
          stderr: toolResult.stderr,
        });

        setThinkingMessage(getRandomThinkingVerb());
        refreshDerived();

        const decision = {
          type: "approve" as const,
          approval,
          precomputedResult: toolResult,
        };

        if (isLast) {
          setIsExecutingTool(true);
          await sendAllResults(decision);
        } else {
          setApprovalResults((prev) => [...prev, decision]);
        }
      } catch (e) {
        const errorDetails = formatErrorDetails(e, agentId);
        appendError(errorDetails, {
          ...extractErrorMeta(e),
          context: "approval_send",
        });
        setStreaming(false);
      }
    },
    [
      agentId,
      pendingApprovals,
      approvalResults,
      sendAllResults,
      appendError,
      refreshDerived,
      setStreaming,
      setUiPermissionMode,
    ],
  );

  const handlePlanKeepPlanning = useCallback(
    async (reason: string) => {
      const currentIndex = approvalResults.length;
      const approval = pendingApprovals[currentIndex];
      if (!approval) return;

      const isLast = currentIndex + 1 >= pendingApprovals.length;

      // Stay in plan mode
      const denialReason =
        reason ||
        "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";

      const decision = {
        type: "deny" as const,
        approval,
        reason: denialReason,
      };

      if (isLast) {
        setIsExecutingTool(true);
        await sendAllResults(decision);
      } else {
        setApprovalResults((prev) => [...prev, decision]);
      }
    },
    [pendingApprovals, approvalResults, sendAllResults],
  );

  // Guard ExitPlanMode:
  // - If not in plan mode, allow graceful continuation when we still have a known plan file path
  // - Otherwise reject with an expiry message
  // - If in plan mode but no plan file exists, keep planning
  useEffect(() => {
    const currentIndex = approvalResults.length;
    const approval = pendingApprovals[currentIndex];
    if (approval?.toolName === "ExitPlanMode") {
      if (
        lastAutoHandledExitPlanToolCallIdRef.current === approval.toolCallId
      ) {
        return;
      }

      const mode = permissionMode.getMode();
      const activePlanPath = permissionMode.getPlanFilePath();
      const fallbackPlanPath = lastPlanFilePathRef.current;
      const hasUsablePlan = planFileExists(fallbackPlanPath);

      if (mode !== "plan") {
        if (hasUsablePlan) {
          // Keep approval flow alive and let user manually approve.
          return;
        }

        if (mode === "bypassPermissions") {
          // YOLO mode but no plan file yet — tell agent to write it first.
          const planFilePath = activePlanPath ?? fallbackPlanPath;
          const plansDir = join(homedir(), ".letta", "plans");
          handlePlanKeepPlanning(
            `You must write your plan to a plan file before exiting plan mode.\n` +
              (planFilePath ? `Plan file path: ${planFilePath}\n` : "") +
              `Use a write tool to create your plan in ${plansDir}, then use ExitPlanMode to present the plan to the user.`,
          );
          return;
        }

        // Plan mode state was lost and no plan file is recoverable (e.g., CLI restart)
        const statusId = uid("status");
        buffersRef.current.byId.set(statusId, {
          kind: "status",
          id: statusId,
          lines: ["⚠️ Plan mode session expired (use /plan to re-enter)"],
        });
        buffersRef.current.order.push(statusId);

        // Queue denial to send with next message (same pattern as handleCancelApprovals)
        lastAutoHandledExitPlanToolCallIdRef.current = approval.toolCallId;
        const denialResults = [
          {
            type: "approval" as const,
            tool_call_id: approval.toolCallId,
            approve: false,
            reason:
              "Plan mode session expired (CLI restarted or no recoverable plan file). Use EnterPlanMode to re-enter plan mode, or request the user to re-enter plan mode.",
          },
        ];
        queueApprovalResults(denialResults);

        // Mark tool as cancelled in buffers
        markIncompleteToolsAsCancelled(
          buffersRef.current,
          true,
          "internal_cancel",
        );
        refreshDerived();

        // Clear all approval state (same as handleCancelApprovals)
        setPendingApprovals([]);
        setApprovalContexts([]);
        setApprovalResults([]);
        setAutoHandledResults([]);
        setAutoDeniedApprovals([]);
        return;
      }

      // Mode is plan: require an existing plan file (active or fallback)
      if (!hasUsablePlan) {
        lastAutoHandledExitPlanToolCallIdRef.current = approval.toolCallId;
        const planFilePath = activePlanPath ?? fallbackPlanPath;
        const plansDir = join(homedir(), ".letta", "plans");
        handlePlanKeepPlanning(
          `You must write your plan to a plan file before exiting plan mode.\n` +
            (planFilePath ? `Plan file path: ${planFilePath}\n` : "") +
            `Use a write tool to create your plan in ${plansDir}, then use ExitPlanMode to present the plan to the user.`,
        );
      }
    }
  }, [
    pendingApprovals,
    approvalResults.length,
    handlePlanKeepPlanning,
    refreshDerived,
    queueApprovalResults,
  ]);

  const handleQuestionSubmit = useCallback(
    async (answers: Record<string, string>) => {
      const currentIndex = approvalResults.length;
      const approval = pendingApprovals[currentIndex];
      if (!approval) return;

      const isLast = currentIndex + 1 >= pendingApprovals.length;

      // Get questions from approval args
      const questions = getQuestionsFromApproval(approval);

      // Check for memory preference question and update setting
      parseMemoryPreference(questions, answers, agentId);

      // Format the answer string like Claude Code does
      // Filter out malformed questions (LLM might send invalid data)
      const answerParts = questions
        .filter((q) => q.question)
        .map((q) => {
          const answer = answers[q.question] || "";
          return `"${q.question}"="${answer}"`;
        });
      const toolReturn = `User has answered your questions: ${answerParts.join(", ")}. You can now continue with the user's answers in mind.`;

      const precomputedResult: ToolExecutionResult = {
        toolReturn,
        status: "success",
      };

      // Update buffers with tool return
      onChunk(buffersRef.current, {
        message_type: "tool_return_message",
        id: "dummy",
        date: new Date().toISOString(),
        tool_call_id: approval.toolCallId,
        tool_return: toolReturn,
        status: "success",
        stdout: null,
        stderr: null,
      });

      setThinkingMessage(getRandomThinkingVerb());
      refreshDerived();

      const decision = {
        type: "approve" as const,
        approval,
        precomputedResult,
      };

      if (isLast) {
        setIsExecutingTool(true);
        await sendAllResults(decision);
      } else {
        setApprovalResults((prev) => [...prev, decision]);
      }
    },
    [
      pendingApprovals,
      approvalResults,
      sendAllResults,
      refreshDerived,
      agentId,
    ],
  );

  const handleEnterPlanModeApprove = useCallback(
    async (preserveMode: boolean = false) => {
      const currentIndex = approvalResults.length;
      const approval = pendingApprovals[currentIndex];
      if (!approval) return;

      const isLast = currentIndex + 1 >= pendingApprovals.length;

      // Generate plan file path
      const planFilePath = generatePlanFilePath();
      const applyPatchRelativePath = relative(
        process.cwd(),
        planFilePath,
      ).replace(/\\/g, "/");

      // Store plan file path
      permissionMode.setPlanFilePath(planFilePath);
      cacheLastPlanFilePath(planFilePath);

      if (!preserveMode) {
        // Normal flow: switch to plan mode
        permissionMode.setMode("plan");
        setUiPermissionMode("plan");
      }

      // Get the tool return message from the implementation
      const toolReturn = `Entered plan mode. You should now focus on exploring the codebase and designing an implementation approach.

In plan mode, you should:
1. Thoroughly explore the codebase to understand existing patterns
2. Identify similar features and architectural approaches
3. Consider multiple approaches and their trade-offs
4. Use AskUserQuestion if you need to clarify the approach
5. Design a concrete implementation strategy
6. When ready, use ExitPlanMode to present your plan for approval

Remember: DO NOT write or edit any files yet. This is a read-only exploration and planning phase.

Plan file path: ${planFilePath}
If using apply_patch, use this exact relative patch path: ${applyPatchRelativePath}`;

      const precomputedResult: ToolExecutionResult = {
        toolReturn,
        status: "success",
      };

      // Update buffers with tool return
      onChunk(buffersRef.current, {
        message_type: "tool_return_message",
        id: "dummy",
        date: new Date().toISOString(),
        tool_call_id: approval.toolCallId,
        tool_return: toolReturn,
        status: "success",
        stdout: null,
        stderr: null,
      });

      setThinkingMessage(getRandomThinkingVerb());
      refreshDerived();

      const decision = {
        type: "approve" as const,
        approval,
        precomputedResult,
      };

      if (isLast) {
        setIsExecutingTool(true);
        await sendAllResults(decision);
      } else {
        setApprovalResults((prev) => [...prev, decision]);
      }
    },
    [
      pendingApprovals,
      approvalResults,
      sendAllResults,
      refreshDerived,
      setUiPermissionMode,
      cacheLastPlanFilePath,
    ],
  );

  const handleEnterPlanModeReject = useCallback(async () => {
    const currentIndex = approvalResults.length;
    const approval = pendingApprovals[currentIndex];
    if (!approval) return;

    const isLast = currentIndex + 1 >= pendingApprovals.length;

    const rejectionReason =
      "User chose to skip plan mode and start implementing directly.";

    const decision = {
      type: "deny" as const,
      approval,
      reason: rejectionReason,
    };

    if (isLast) {
      setIsExecutingTool(true);
      await sendAllResults(decision);
    } else {
      setApprovalResults((prev) => [...prev, decision]);
    }
  }, [pendingApprovals, approvalResults, sendAllResults]);

  // Guard EnterPlanMode:
  // When in bypassPermissions (YOLO) mode, auto-approve EnterPlanMode and stay
  // in YOLO — the agent gets plan instructions but keeps full permissions.
  // ExitPlanMode still requires explicit user approval.
  useEffect(() => {
    const currentIndex = approvalResults.length;
    const approval = pendingApprovals[currentIndex];
    if (approval?.toolName === "EnterPlanMode") {
      if (permissionMode.getMode() === "bypassPermissions") {
        if (
          lastAutoApprovedEnterPlanToolCallIdRef.current === approval.toolCallId
        ) {
          return;
        }
        lastAutoApprovedEnterPlanToolCallIdRef.current = approval.toolCallId;
        handleEnterPlanModeApprove(true);
      }
    }
  }, [pendingApprovals, approvalResults.length, handleEnterPlanModeApprove]);

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
            agentProvenance,
            terminalWidth: columns,
          },
        },
      ]);

      // Add status line showing agent info
      const statusId = `status-agent-${Date.now().toString(36)}`;

      // Check if agent is pinned (locally or globally)
      const isPinned = agentState?.id
        ? settingsManager.getLocalPinnedAgents().includes(agentState.id) ||
          settingsManager.getGlobalPinnedAgents().includes(agentState.id)
        : false;

      // Build status message based on session type
      const agentName = agentState?.name || "Unnamed Agent";
      const headerMessage = resumedExistingConversation
        ? `Resuming (empty) conversation with **${agentName}**`
        : continueSession
          ? `Starting new conversation with **${agentName}**`
          : "Creating a new agent";

      // Command hints - for pinned agents show /memory, for unpinned show /pin
      const commandHints = isPinned
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
  const inputEnabled =
    !showExitStats && pendingApprovals.length === 0 && !anySelectorOpen;
  const currentApprovalPreviewCommitted = currentApproval?.toolCallId
    ? eagerCommittedPreviewsRef.current.has(currentApproval.toolCallId)
    : false;
  const showApprovalPreview =
    !currentApprovalShouldCommitPreview && !currentApprovalPreviewCommitted;

  useEffect(() => {
    trajectoryTokenDisplayRef.current = trajectoryTokenDisplay;
  }, [trajectoryTokenDisplay]);

  return (
    <Box key={resumeKey} flexDirection="column">
      <StaticTranscript
        renderEpoch={staticRenderEpoch}
        items={staticItems}
        columns={columns}
        statusLinePrompt={statusLine.prompt}
        showCompactionsEnabled={showCompactionsEnabled}
        precomputedDiffs={precomputedDiffsRef.current}
        lastPlanFilePath={lastPlanFilePathRef.current}
      />

      <Box flexDirection="column">
        {/* Loading screen / intro text */}
        {loadingState !== "ready" && (
          <WelcomeScreen
            loadingState={loadingState}
            continueSession={continueSession}
            agentState={agentState}
          />
        )}

        {loadingState === "ready" && (
          <>
            {/* Transcript - wrapped in AnimationProvider for overflow-based animation control */}
            <AnimationProvider shouldAnimate={shouldAnimate}>
              {/* Show liveItems always - all approvals now render inline */}
              {liveItems.length > 0 && (
                <Box flexDirection="column">
                  {liveItems.map((ln) => {
                    const isFileTool =
                      ln.kind === "tool_call" &&
                      ln.name &&
                      (isFileEditTool(ln.name) ||
                        isFileWriteTool(ln.name) ||
                        isPatchTool(ln.name));
                    const isApprovalTracked =
                      ln.kind === "tool_call" &&
                      ln.toolCallId &&
                      (ln.toolCallId === currentApproval?.toolCallId ||
                        pendingIds.has(ln.toolCallId) ||
                        queuedIds.has(ln.toolCallId));
                    if (isFileTool && !isApprovalTracked) {
                      return null;
                    }
                    // Skip Task tools that don't have a pending approval
                    // They render as empty Boxes (ToolCallMessage returns null for non-finished Task tools)
                    // which causes N blank lines when N Task tools are called in parallel
                    // Note: pendingIds doesn't include the ACTIVE approval (currentApproval),
                    // so we must also check if this is the active approval
                    if (
                      ln.kind === "tool_call" &&
                      ln.name &&
                      isTaskTool(ln.name) &&
                      ln.toolCallId &&
                      !pendingIds.has(ln.toolCallId) &&
                      ln.toolCallId !== currentApproval?.toolCallId
                    ) {
                      return null;
                    }

                    // Check if this tool call matches the current approval awaiting user input
                    const matchesCurrentApproval =
                      ln.kind === "tool_call" &&
                      currentApproval &&
                      ln.toolCallId === currentApproval.toolCallId;

                    return (
                      <Box key={ln.id} flexDirection="column" marginTop={1}>
                        {matchesCurrentApproval ? (
                          <ApprovalSwitch
                            approval={currentApproval}
                            onApprove={handleApproveCurrent}
                            onApproveAlways={handleApproveAlways}
                            onDeny={handleDenyCurrent}
                            onCancel={handleCancelApprovals}
                            onPlanApprove={handlePlanApprove}
                            onPlanKeepPlanning={handlePlanKeepPlanning}
                            onQuestionSubmit={handleQuestionSubmit}
                            onEnterPlanModeApprove={handleEnterPlanModeApprove}
                            onEnterPlanModeReject={handleEnterPlanModeReject}
                            precomputedDiff={
                              ln.toolCallId
                                ? precomputedDiffsRef.current.get(ln.toolCallId)
                                : undefined
                            }
                            allDiffs={precomputedDiffsRef.current}
                            isFocused={true}
                            approveAlwaysText={
                              currentApprovalContext?.approveAlwaysText
                            }
                            allowPersistence={
                              currentApprovalContext?.allowPersistence ?? true
                            }
                            defaultScope={
                              currentApprovalContext?.defaultScope === "user"
                                ? "session"
                                : (currentApprovalContext?.defaultScope ??
                                  "project")
                            }
                            showPreview={showApprovalPreview}
                            planContent={
                              currentApproval.toolName === "ExitPlanMode"
                                ? _readPlanFile(lastPlanFilePathRef.current)
                                : undefined
                            }
                            planFilePath={
                              currentApproval.toolName === "ExitPlanMode"
                                ? (permissionMode.getPlanFilePath() ??
                                  lastPlanFilePathRef.current ??
                                  undefined)
                                : undefined
                            }
                            agentName={agentName ?? undefined}
                          />
                        ) : ln.kind === "user" ? (
                          <UserMessage line={ln} prompt={statusLine.prompt} />
                        ) : ln.kind === "reasoning" ? (
                          <ReasoningMessage line={ln} />
                        ) : ln.kind === "assistant" ? (
                          <AssistantMessage line={ln} />
                        ) : ln.kind === "tool_call" &&
                          ln.toolCallId &&
                          queuedIds.has(ln.toolCallId) ? (
                          // Render stub for queued (decided but not executed) approval
                          <PendingApprovalStub
                            toolName={
                              approvalMap.get(ln.toolCallId)?.toolName ||
                              ln.name ||
                              "Unknown"
                            }
                            description={stubDescriptions.get(ln.toolCallId)}
                            decision={queuedDecisions.get(ln.toolCallId)}
                          />
                        ) : ln.kind === "tool_call" &&
                          ln.toolCallId &&
                          pendingIds.has(ln.toolCallId) ? (
                          // Render stub for pending (undecided) approval
                          <PendingApprovalStub
                            toolName={
                              approvalMap.get(ln.toolCallId)?.toolName ||
                              ln.name ||
                              "Unknown"
                            }
                            description={stubDescriptions.get(ln.toolCallId)}
                          />
                        ) : ln.kind === "tool_call" ? (
                          <ToolCallMessage
                            line={ln}
                            precomputedDiffs={precomputedDiffsRef.current}
                            lastPlanFilePath={lastPlanFilePathRef.current}
                            isStreaming={streaming}
                          />
                        ) : ln.kind === "error" ? (
                          <ErrorMessage line={ln} />
                        ) : ln.kind === "status" ? (
                          <StatusMessage line={ln} />
                        ) : ln.kind === "event" ? (
                          <EventMessage line={ln} />
                        ) : ln.kind === "command" ? (
                          <CommandMessage line={ln} />
                        ) : ln.kind === "bash_command" ? (
                          <BashCommandMessage line={ln} />
                        ) : null}
                      </Box>
                    );
                  })}
                </Box>
              )}

              {/* Fallback approval UI when backfill is disabled (no liveItems) */}
              {liveItems.length === 0 && currentApproval && (
                <Box flexDirection="column">
                  <ApprovalSwitch
                    approval={currentApproval}
                    onApprove={handleApproveCurrent}
                    onApproveAlways={handleApproveAlways}
                    onDeny={handleDenyCurrent}
                    onCancel={handleCancelApprovals}
                    onPlanApprove={handlePlanApprove}
                    onPlanKeepPlanning={handlePlanKeepPlanning}
                    onQuestionSubmit={handleQuestionSubmit}
                    onEnterPlanModeApprove={handleEnterPlanModeApprove}
                    onEnterPlanModeReject={handleEnterPlanModeReject}
                    allDiffs={precomputedDiffsRef.current}
                    isFocused={true}
                    approveAlwaysText={
                      currentApprovalContext?.approveAlwaysText
                    }
                    allowPersistence={
                      currentApprovalContext?.allowPersistence ?? true
                    }
                    defaultScope={
                      currentApprovalContext?.defaultScope === "user"
                        ? "session"
                        : (currentApprovalContext?.defaultScope ?? "project")
                    }
                    showPreview={showApprovalPreview}
                    planContent={
                      currentApproval.toolName === "ExitPlanMode"
                        ? _readPlanFile(lastPlanFilePathRef.current)
                        : undefined
                    }
                    planFilePath={
                      currentApproval.toolName === "ExitPlanMode"
                        ? (permissionMode.getPlanFilePath() ??
                          lastPlanFilePathRef.current ??
                          undefined)
                        : undefined
                    }
                    agentName={agentName ?? undefined}
                  />
                </Box>
              )}

              {/* Subagent group display - shows running/completed subagents */}
              <SubagentGroupDisplay />
            </AnimationProvider>

            {/* Exit stats - shown when exiting via double Ctrl+C */}
            {showExitStats &&
              (() => {
                const stats = sessionStatsRef.current.getSnapshot();
                return (
                  <ExitStats
                    stats={stats}
                    agentName={agentName}
                    agentId={agentId}
                    conversationId={conversationId}
                  />
                );
              })()}

            {/* /btw ephemeral pane - shows forked conversation response */}
            {btwState.status !== "idle" && (
              <BtwPane
                state={btwState}
                onJumpToConversation={handleBtwJump}
                onDismiss={() => setBtwState({ status: "idle" })}
              />
            )}

            {/* Input row - always mounted to preserve state */}
            <Box marginTop={1}>
              <Input
                visible={inputVisible}
                streaming={streaming}
                tokenCount={trajectoryTokenDisplay}
                elapsedBaseMs={liveTrajectoryElapsedBaseMs}
                thinkingMessage={thinkingMessage}
                includeSystemPromptUpgradeTip={includeSystemPromptUpgradeTip}
                onSubmit={onSubmit}
                onBashSubmit={handleBashSubmit}
                bashRunning={bashRunning}
                onBashInterrupt={handleBashInterrupt}
                inputEnabled={inputEnabled}
                collapseInputWhenDisabled={
                  pendingApprovals.length > 0 || anySelectorOpen
                }
                permissionMode={uiPermissionMode}
                onPermissionModeChange={handlePermissionModeChange}
                onCycleReasoningEffort={
                  reasoningTabCycleEnabled
                    ? handleCycleReasoningEffort
                    : undefined
                }
                onExit={handleExit}
                onInterrupt={handleInterrupt}
                interruptRequested={interruptRequested}
                agentId={agentId}
                agentName={agentName}
                currentModel={currentModelDisplay}
                currentModelProvider={currentModelProvider}
                hasTemporaryModelOverride={hasTemporaryModelOverride}
                currentReasoningEffort={currentReasoningEffort}
                messageQueue={queueDisplay}
                onEnterQueueEditMode={handleEnterQueueEditMode}
                onEscapeCancel={
                  profileConfirmPending ? handleProfileEscapeCancel : undefined
                }
                inputDisabled={btwState.status === "complete"}
                ralphActive={uiRalphActive}
                ralphPending={pendingRalphConfig !== null}
                ralphPendingYolo={pendingRalphConfig?.isYolo ?? false}
                onRalphExit={handleRalphExit}
                conversationId={conversationId}
                onPasteError={handlePasteError}
                restoredInput={restoredInput}
                onRestoredInputConsumed={() => setRestoredInput(null)}
                networkPhase={networkPhase}
                terminalWidth={chromeColumns}
                shouldAnimate={shouldAnimate}
                statusLineText={statusLine.text || undefined}
                statusLineRight={statusLine.rightText || undefined}
                statusLinePadding={statusLine.padding || 0}
                statusLinePrompt={statusLine.prompt}
                footerNotification={footerUpdateText}
              />
            </Box>

            {/* Model Selector - conditionally mounted as overlay */}
            {activeOverlay === "model" &&
              (modelReasoningPrompt ? (
                <ModelReasoningSelector
                  modelLabel={modelReasoningPrompt.modelLabel}
                  options={modelReasoningPrompt.options}
                  initialModelId={modelReasoningPrompt.initialModelId}
                  onSelect={(selectedModelId) => {
                    setModelReasoningPrompt(null);
                    void handleModelSelect(selectedModelId, null, {
                      skipReasoningPrompt: true,
                    });
                  }}
                  onCancel={() => setModelReasoningPrompt(null)}
                />
              ) : (
                <ModelSelector
                  currentModelId={currentModelId ?? undefined}
                  onSelect={handleModelSelect}
                  onCancel={closeOverlay}
                  filterProvider={modelSelectorOptions.filterProvider}
                  forceRefresh={modelSelectorOptions.forceRefresh}
                  billingTier={billingTier ?? undefined}
                  isSelfHosted={(() => {
                    const settings = settingsManager.getSettings();
                    const baseURL =
                      process.env.LETTA_BASE_URL ||
                      settings.env?.LETTA_BASE_URL ||
                      "https://api.letta.com";
                    return !baseURL.includes("api.letta.com");
                  })()}
                  localModelCatalog={
                    getBackend().capabilities.localModelCatalog
                  }
                />
              ))}

            {activeOverlay === "sleeptime" && (
              <SleeptimeSelector
                initialSettings={getReflectionSettings(agentId)}
                memfsEnabled={settingsManager.isMemfsEnabled(agentId)}
                onSave={handleSleeptimeModeSelect}
                onCancel={closeOverlay}
              />
            )}

            {activeOverlay === "compaction" && (
              <CompactionSelector
                initialMode={agentState?.compaction_settings?.mode}
                onSave={handleCompactionModeSelect}
                onCancel={closeOverlay}
              />
            )}

            {/* GitHub App Installer - setup Letta Code GitHub Action */}
            {activeOverlay === "install-github-app" && (
              <InstallGithubAppFlow
                onComplete={(result) => {
                  const overlayCommand =
                    consumeOverlayCommand("install-github-app");
                  closeOverlay();

                  const cmd =
                    overlayCommand ??
                    commandRunner.start(
                      "/install-github-app",
                      "Setting up Letta Code GitHub Action...",
                    );

                  if (!result.committed) {
                    cmd.finish(
                      [
                        `Workflow already up to date for ${result.repo}.`,
                        result.secretAction === "reused"
                          ? "Using existing LETTA_API_KEY secret."
                          : "Updated LETTA_API_KEY secret.",
                        "No pull request needed.",
                      ].join("\n"),
                      true,
                    );
                    return;
                  }

                  const lines: string[] = ["Install GitHub App", "Success", ""];
                  lines.push("✓ GitHub Actions workflow created!");
                  lines.push("");
                  lines.push(
                    result.secretAction === "reused"
                      ? "✓ Using existing LETTA_API_KEY secret"
                      : "✓ API key saved as LETTA_API_KEY secret",
                  );
                  if (result.agentId) {
                    lines.push("");
                    lines.push(`✓ Agent configured: ${result.agentId}`);
                  }
                  lines.push("");
                  lines.push("Next steps:");

                  if (result.pullRequestUrl) {
                    lines.push(
                      result.pullRequestCreateMode === "page-opened"
                        ? "1. A pre-filled PR page has been created"
                        : "1. A pull request has been created",
                    );
                    lines.push("2. Merge the PR to enable Letta PR assistance");
                    lines.push(
                      "3. Mention @letta-code in an issue or PR to test",
                    );
                    lines.push("");
                    lines.push(`PR: ${result.pullRequestUrl}`);
                    if (result.agentUrl) {
                      lines.push(`Agent: ${result.agentUrl}`);
                    }
                  } else {
                    lines.push(
                      "1. Open a PR for the branch created by the installer",
                    );
                    lines.push("2. Merge the PR to enable Letta PR assistance");
                    lines.push(
                      "3. Mention @letta-code in an issue or PR to test",
                    );
                    lines.push("");
                    lines.push(
                      "Branch pushed but PR was not opened automatically. Run: gh pr create",
                    );
                  }
                  cmd.finish(lines.join("\n"), true);
                }}
                onCancel={closeOverlay}
              />
            )}

            {/* Provider Selector - for connecting BYOK providers */}
            {activeOverlay === "connect" && (
              <ProviderSelector
                onCancel={closeOverlay}
                onStartOAuth={async () => {
                  const overlayCommand = consumeOverlayCommand("connect");
                  // Close selector and start OAuth flow
                  closeOverlay();
                  const cmd =
                    overlayCommand ??
                    commandRunner.start("/connect", "Starting connection...");
                  const {
                    handleConnect,
                    setActiveCommandId: setActiveConnectCommandId,
                  } = await import("../commands/connect");
                  setActiveConnectCommandId(cmd.id);
                  try {
                    await handleConnect(
                      {
                        buffersRef,
                        refreshDerived,
                        setCommandRunning,
                        onCodexConnected: () => {
                          setModelSelectorOptions({
                            filterProvider: "chatgpt-plus-pro",
                            forceRefresh: true,
                          });
                          startOverlayCommand(
                            "model",
                            "/model",
                            "Opening model selector...",
                            "Models dialog dismissed",
                          );
                          setActiveOverlay("model");
                        },
                      },
                      "/connect chatgpt",
                    );
                  } finally {
                    setActiveConnectCommandId(null);
                  }
                }}
              />
            )}

            {/* Experiment Selector - conditionally mounted as overlay */}
            {activeOverlay === "experiment" && (
              <ExperimentSelector
                experiments={experimentManager.list()}
                onSelect={handleExperimentSelect}
                onCancel={closeOverlay}
              />
            )}

            {/* Toolset Selector - conditionally mounted as overlay */}
            {activeOverlay === "toolset" && (
              <ToolsetSelector
                currentToolset={currentToolset ?? undefined}
                currentPreference={currentToolsetPreference}
                onSelect={handleToolsetSelect}
                onCancel={closeOverlay}
              />
            )}

            {/* System Prompt Selector - conditionally mounted as overlay */}
            {activeOverlay === "system" && (
              <SystemPromptSelector
                currentPromptId={currentSystemPromptId ?? undefined}
                onSelect={handleSystemPromptSelect}
                onCancel={closeOverlay}
              />
            )}

            {activeOverlay === "personality" && (
              <PersonalitySelector
                currentPersonalityId={currentPersonalityId ?? undefined}
                onSelect={handlePersonalitySelect}
                onCancel={closeOverlay}
              />
            )}

            {/* Subagent Manager - for managing custom subagents */}
            {activeOverlay === "subagent" && (
              <SubagentManager onClose={closeOverlay} />
            )}

            {/* Agent Selector - for browsing/selecting agents */}
            {activeOverlay === "resume" && (
              <AgentSelector
                currentAgentId={agentId}
                onSelect={async (id) => {
                  const overlayCommand = consumeOverlayCommand("resume");
                  closeOverlay();
                  await handleAgentSelect(id, {
                    commandId: overlayCommand?.id,
                  });
                }}
                onCancel={closeOverlay}
                onCreateNewAgent={() => {
                  closeOverlay();
                  setActiveOverlay("new");
                }}
              />
            )}

            {/* Conversation Selector - for resuming conversations */}
            {activeOverlay === "conversations" && (
              <ConversationSelector
                agentId={agentId}
                agentName={agentName ?? undefined}
                currentConversationId={conversationId}
                onSelect={async (convId, selectorContext) => {
                  const overlayCommand = consumeOverlayCommand("conversations");
                  closeOverlay();

                  // Skip if already on this conversation
                  if (convId === conversationId) {
                    const cmd =
                      overlayCommand ??
                      commandRunner.start(
                        "/resume",
                        "Already on this conversation",
                      );
                    cmd.finish("Already on this conversation", true);
                    return;
                  }

                  // If agent is busy, queue the switch for after end_turn
                  if (isAgentBusy()) {
                    const cmd =
                      overlayCommand ??
                      commandRunner.start(
                        "/resume",
                        "Conversation switch queued – will switch after current task completes",
                      );
                    cmd.update({
                      output:
                        "Conversation switch queued – will switch after current task completes",
                      phase: "running",
                    });
                    setQueuedOverlayAction({
                      type: "switch_conversation",
                      conversationId: convId,
                      commandId: cmd.id,
                    });
                    return;
                  }

                  // Lock input for async operation
                  setCommandRunning(true);

                  const inputCmd = "/resume";
                  const cmd =
                    overlayCommand ??
                    commandRunner.start(inputCmd, "Switching conversation...");
                  cmd.update({
                    output: "Switching conversation...",
                    phase: "running",
                  });

                  try {
                    // Validate conversation exists BEFORE updating state
                    // (getResumeData throws 404/422 for non-existent conversations)
                    if (agentState) {
                      const resumeData = await getResumeDataFromBackend(
                        agentState,
                        convId,
                      );

                      // Only update state after validation succeeds
                      setConversationIdAndRef(convId);
                      setConversationAutoTitleEligibility(false);

                      pendingConversationSwitchRef.current = {
                        origin: "resume-selector",
                        conversationId: convId,
                        isDefault: convId === "default",
                        messageCount:
                          selectorContext?.messageCount ??
                          resumeData.messageHistory.length,
                        summary: selectorContext?.summary,
                        messageHistory: resumeData.messageHistory,
                      };

                      settingsManager.persistSession(agentId, convId);

                      // Build success command with agent + conversation info
                      const currentAgentName =
                        agentState.name || "Unnamed Agent";
                      const successLines =
                        resumeData.messageHistory.length > 0
                          ? [
                              `Resumed conversation with "${currentAgentName}"`,
                              `⎿  Agent: ${agentId}`,
                              `⎿  Conversation: ${convId}`,
                            ]
                          : [
                              `Switched to conversation with "${currentAgentName}"`,
                              `⎿  Agent: ${agentId}`,
                              `⎿  Conversation: ${convId} (empty)`,
                            ];
                      const successOutput = successLines.join("\n");
                      cmd.finish(successOutput, true);
                      const successItem: StaticItem = {
                        kind: "command",
                        id: cmd.id,
                        input: cmd.input,
                        output: successOutput,
                        phase: "finished",
                        success: true,
                      };

                      // Clear current transcript and static items
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

                      // Backfill message history with visual separator
                      if (resumeData.messageHistory.length > 0) {
                        hasBackfilledRef.current = false;
                        backfillBuffers(
                          buffersRef.current,
                          resumeData.messageHistory,
                        );
                        // Collect backfilled items
                        const backfilledItems: StaticItem[] = [];
                        for (const id of buffersRef.current.order) {
                          const ln = buffersRef.current.byId.get(id);
                          if (!ln) continue;
                          emittedIdsRef.current.add(id);
                          backfilledItems.push({ ...ln } as StaticItem);
                        }
                        // Add separator before backfilled messages, then success at end
                        const separator = {
                          kind: "separator" as const,
                          id: uid("sep"),
                        };
                        setStaticItems([
                          separator,
                          ...backfilledItems,
                          successItem,
                        ]);
                        setLines(toLines(buffersRef.current));
                        hasBackfilledRef.current = true;
                      } else {
                        // Add separator for visual spacing even without backfill
                        const separator = {
                          kind: "separator" as const,
                          id: uid("sep"),
                        };
                        setStaticItems([separator, successItem]);
                        setLines(toLines(buffersRef.current));
                      }

                      // Restore pending approvals if any (fixes #540 for ConversationSelector)
                      if (resumeData.pendingApprovals.length > 0) {
                        await recoverRestoredPendingApprovals(
                          resumeData.pendingApprovals,
                        );
                      }
                    }
                  } catch (error) {
                    // Update existing loading message instead of creating new one
                    // Format error message to be user-friendly (avoid raw JSON/internal details)
                    let errorMsg = "Unknown error";
                    if (error instanceof APIError) {
                      if (error.status === 404) {
                        errorMsg = "Conversation not found";
                      } else if (error.status === 422) {
                        errorMsg = "Invalid conversation ID";
                      } else {
                        errorMsg = error.message;
                      }
                    } else if (error instanceof Error) {
                      errorMsg = error.message;
                    }
                    cmd.fail(`Failed to switch conversation: ${errorMsg}`);
                  } finally {
                    setCommandRunning(false);
                  }
                }}
                onNewConversation={async () => {
                  const overlayCommand = consumeOverlayCommand("conversations");
                  closeOverlay();

                  // Lock input for async operation
                  setCommandRunning(true);

                  const cmd =
                    overlayCommand ??
                    commandRunner.start(
                      "/resume",
                      "Creating new conversation...",
                    );
                  cmd.update({
                    output: "Creating new conversation...",
                    phase: "running",
                  });

                  try {
                    // Create a new conversation
                    const conversation = await getBackend().createConversation({
                      agent_id: agentId,
                      isolated_block_labels: [...ISOLATED_BLOCK_LABELS],
                    });

                    await maybeCarryOverActiveConversationModel(
                      conversation.id,
                    );
                    setConversationIdAndRef(conversation.id);
                    setConversationAutoTitleEligibility(true);
                    settingsManager.persistSession(agentId, conversation.id);

                    // Build success command with agent + conversation info
                    const currentAgentName =
                      agentState?.name || "Unnamed Agent";
                    const shortConvId = conversation.id.slice(0, 20);
                    const successLines = [
                      `Started new conversation with "${currentAgentName}"`,
                      `⎿  Agent: ${agentId}`,
                      `⎿  Conversation: ${shortConvId}... (new)`,
                    ];
                    const successOutput = successLines.join("\n");
                    cmd.finish(successOutput, true);
                    const successItem: StaticItem = {
                      kind: "command",
                      id: cmd.id,
                      input: cmd.input,
                      output: successOutput,
                      phase: "finished",
                      success: true,
                    };

                    // Clear current transcript and static items
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
                    setStaticItems([successItem]);
                    setLines(toLines(buffersRef.current));
                  } catch (error) {
                    cmd.fail(
                      `Failed to create conversation: ${error instanceof Error ? error.message : String(error)}`,
                    );
                  } finally {
                    setCommandRunning(false);
                  }
                }}
                onCancel={closeOverlay}
              />
            )}

            {/* Message Search - conditionally mounted as overlay */}
            {activeOverlay === "search" && (
              <MessageSearch
                onClose={closeOverlay}
                initialQuery={searchQuery || undefined}
                agentId={agentId}
                conversationId={conversationId}
                onOpenConversation={async (
                  targetAgentId,
                  targetConvId,
                  searchContext,
                ) => {
                  const overlayCommand = consumeOverlayCommand("search");
                  closeOverlay();

                  // Different agent: use handleAgentSelect (which supports optional conversationId)
                  if (targetAgentId !== agentId) {
                    await handleAgentSelect(targetAgentId, {
                      conversationId: targetConvId,
                      commandId: overlayCommand?.id,
                    });
                    return;
                  }

                  // Normalize undefined/null to "default"
                  const actualTargetConv = targetConvId || "default";

                  // Same agent, same conversation: nothing to do
                  if (actualTargetConv === conversationId) {
                    const cmd =
                      overlayCommand ??
                      commandRunner.start(
                        "/search",
                        "Already on this conversation",
                      );
                    cmd.finish("Already on this conversation", true);
                    return;
                  }

                  // Same agent, different conversation: switch conversation
                  // (Reuses ConversationSelector's onSelect logic pattern)
                  if (isAgentBusy()) {
                    const cmd =
                      overlayCommand ??
                      commandRunner.start(
                        "/search",
                        "Conversation switch queued – will switch after current task completes",
                      );
                    cmd.update({
                      output:
                        "Conversation switch queued – will switch after current task completes",
                      phase: "running",
                    });
                    setQueuedOverlayAction({
                      type: "switch_conversation",
                      conversationId: actualTargetConv,
                      commandId: cmd.id,
                    });
                    return;
                  }

                  setCommandRunning(true);
                  const cmd =
                    overlayCommand ??
                    commandRunner.start("/search", "Switching conversation...");
                  cmd.update({
                    output: "Switching conversation...",
                    phase: "running",
                  });

                  try {
                    if (agentState) {
                      const resumeData = await getResumeDataFromBackend(
                        agentState,
                        actualTargetConv,
                      );

                      setConversationIdAndRef(actualTargetConv);
                      setConversationAutoTitleEligibility(false);

                      pendingConversationSwitchRef.current = {
                        origin: "search",
                        conversationId: actualTargetConv,
                        isDefault: actualTargetConv === "default",
                        messageCount: resumeData.messageHistory.length,
                        messageHistory: resumeData.messageHistory,
                        searchQuery: searchContext?.query,
                        searchMessage: searchContext?.message,
                      };

                      settingsManager.persistSession(agentId, actualTargetConv);

                      const currentAgentName =
                        agentState.name || "Unnamed Agent";
                      const successOutput = [
                        `Switched to conversation with "${currentAgentName}"`,
                        `⎿  Conversation: ${actualTargetConv}`,
                      ].join("\n");
                      cmd.finish(successOutput, true);
                      const successItem: StaticItem = {
                        kind: "command",
                        id: cmd.id,
                        input: cmd.input,
                        output: successOutput,
                        phase: "finished",
                        success: true,
                      };

                      // Clear current transcript and static items
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
                        backfillBuffers(
                          buffersRef.current,
                          resumeData.messageHistory,
                        );
                        const backfilledItems: StaticItem[] = [];
                        for (const id of buffersRef.current.order) {
                          const ln = buffersRef.current.byId.get(id);
                          if (!ln) continue;
                          emittedIdsRef.current.add(id);
                          backfilledItems.push({ ...ln } as StaticItem);
                        }
                        const separator = {
                          kind: "separator" as const,
                          id: uid("sep"),
                        };
                        setStaticItems([
                          separator,
                          ...backfilledItems,
                          successItem,
                        ]);
                        setLines(toLines(buffersRef.current));
                        hasBackfilledRef.current = true;
                      } else {
                        const separator = {
                          kind: "separator" as const,
                          id: uid("sep"),
                        };
                        setStaticItems([separator, successItem]);
                        setLines(toLines(buffersRef.current));
                      }

                      // Restore pending approvals if any
                      if (resumeData.pendingApprovals.length > 0) {
                        await recoverRestoredPendingApprovals(
                          resumeData.pendingApprovals,
                        );
                      }
                    }
                  } catch (error) {
                    let errorMsg = "Unknown error";
                    if (error instanceof APIError) {
                      if (error.status === 404) {
                        errorMsg = "Conversation not found";
                      } else if (error.status === 422) {
                        errorMsg = "Invalid conversation ID";
                      } else {
                        errorMsg = error.message;
                      }
                    } else if (error instanceof Error) {
                      errorMsg = error.message;
                    }
                    cmd.fail(`Failed: ${errorMsg}`);
                  } finally {
                    setCommandRunning(false);
                  }
                }}
              />
            )}

            {/* Feedback Dialog - conditionally mounted as overlay */}
            {activeOverlay === "feedback" && (
              <FeedbackDialog
                onSubmit={handleFeedbackSubmit}
                onCancel={closeOverlay}
                initialValue={feedbackPrefill}
              />
            )}

            {/* Memory Viewer - conditionally mounted as overlay */}
            {/* Use tree view for memfs-enabled agents, tab view otherwise */}
            {activeOverlay === "memory" &&
              (settingsManager.isMemfsEnabled(agentId) ? (
                <MemfsTreeViewer
                  agentId={agentId}
                  agentName={agentState?.name}
                  onClose={closeOverlay}
                  conversationId={conversationId}
                />
              ) : (
                <MemoryTabViewer
                  blocks={agentState?.memory?.blocks || []}
                  agentId={agentId}
                  onClose={closeOverlay}
                  conversationId={conversationId}
                />
              ))}

            {/* Memory sync conflict overlay removed - git-backed memory
                uses standard git merge conflicts resolved by the agent */}

            {/* MCP Server Selector - conditionally mounted as overlay */}
            {activeOverlay === "mcp" && (
              <McpSelector
                agentId={agentId}
                onAdd={() => {
                  // Switch to the MCP connect flow
                  setActiveOverlay("mcp-connect");
                }}
                onCancel={closeOverlay}
              />
            )}

            {/* MCP Connect Flow - interactive TUI for OAuth connection */}
            {activeOverlay === "mcp-connect" && (
              <McpConnectFlow
                onComplete={(serverName, serverId, toolCount) => {
                  const overlayCommand = consumeOverlayCommand("mcp-connect");
                  closeOverlay();
                  const cmd =
                    overlayCommand ??
                    commandRunner.start(
                      "/mcp connect",
                      "Connecting MCP server...",
                    );
                  cmd.finish(
                    `Successfully created MCP server "${serverName}"\n` +
                      `ID: ${serverId}\n` +
                      `Discovered ${toolCount} tool${toolCount === 1 ? "" : "s"}\n` +
                      "Open /mcp to attach or detach tools for this server.",
                    true,
                  );
                }}
                onCancel={closeOverlay}
              />
            )}

            {/* Help Dialog - conditionally mounted as overlay */}
            {activeOverlay === "help" && <HelpDialog onClose={closeOverlay} />}

            {/* Skills Dialog - browse available skills */}
            {activeOverlay === "skills" && (
              <SkillsDialog onClose={closeOverlay} agentId={agentId} />
            )}

            {/* Hooks Manager - for managing hooks configuration */}
            {activeOverlay === "hooks" && (
              <HooksManager onClose={closeOverlay} agentId={agentId} />
            )}

            {/* New Agent Dialog - for naming new agent before creation */}
            {activeOverlay === "new" && (
              <NewAgentDialog
                onSubmit={handleCreateNewAgent}
                onCancel={closeOverlay}
              />
            )}

            {/* Pin Dialog - for naming agent before pinning */}
            {activeOverlay === "pin" && (
              <PinDialog
                currentName={agentName || ""}
                local={pinDialogLocal}
                onSubmit={async (newName) => {
                  const overlayCommand = consumeOverlayCommand("pin");
                  closeOverlay();
                  setCommandRunning(true);

                  const cmd =
                    overlayCommand ??
                    commandRunner.start("/pin", "Pinning agent...");
                  const scopeText = pinDialogLocal
                    ? "to this project"
                    : "globally";
                  const displayName =
                    newName || agentName || agentId.slice(0, 12);

                  cmd.update({
                    output: `Pinning "${displayName}" ${scopeText}...`,
                    phase: "running",
                  });

                  try {
                    // Rename if new name provided
                    if (newName && newName !== agentName) {
                      await getBackend().updateAgent(agentId, {
                        name: newName,
                      });
                      updateAgentName(newName);
                    }

                    // Pin the agent
                    if (pinDialogLocal) {
                      settingsManager.pinLocal(agentId);
                    } else {
                      settingsManager.pinGlobal(agentId);
                    }

                    if (newName && newName !== agentName) {
                      cmd.agentHint = `Your name is now "${newName}" — acknowledge this and save your new name to memory.`;
                    }
                    cmd.finish(
                      `Pinned "${newName || agentName || agentId.slice(0, 12)}" ${scopeText}.`,
                      true,
                    );
                  } catch (error) {
                    cmd.fail(`Failed to pin: ${error}`);
                  } finally {
                    setCommandRunning(false);
                    refreshDerived();
                  }
                }}
                onCancel={closeOverlay}
              />
            )}

            {/* Plan Mode Dialog - NOW RENDERED INLINE with tool call (see liveItems above) */}
            {/* ExitPlanMode approval is handled by InlinePlanApproval component */}

            {/* AskUserQuestion now rendered inline via InlineQuestionApproval */}
            {/* EnterPlanMode now rendered inline in liveItems above */}
            {/* ApprovalDialog removed - all approvals now render inline via InlineGenericApproval fallback */}
          </>
        )}
      </Box>
    </Box>
  );
}
