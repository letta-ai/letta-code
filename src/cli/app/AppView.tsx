// src/cli/app/AppView.tsx

import { APIError } from "@letta-ai/letta-client/core/error";
import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import { Box } from "ink";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { getResumeDataFromBackend } from "@/agent/check-approval";
import { pinAgentForCurrentUser } from "@/agent/favorites";
import { isActiveMemfsEnabled } from "@/agent/memory-runtime";
import type { ModelReasoningEffort } from "@/agent/model";
import type { PersonalityId } from "@/agent/personality-presets";
import type { SessionStats } from "@/agent/stats";
import { getBackend } from "@/backend";
import type { CommandHandle } from "@/cli/commands/runner";
import { AgentSelector } from "@/cli/components/AgentSelector";
import { ApprovalSwitch } from "@/cli/components/ApprovalSwitch";
import { AssistantMessage } from "@/cli/components/AssistantMessageRich";
import { BashCommandMessage } from "@/cli/components/BashCommandMessage";
import { BtwPane, type BtwState } from "@/cli/components/BtwPane";
import { CommandMessage } from "@/cli/components/CommandMessage";
import { CompactionSelector } from "@/cli/components/CompactionSelector";
import { ConstellationLoginOverlay } from "@/cli/components/ConstellationLoginOverlay";
import { ConversationSelector } from "@/cli/components/ConversationSelector";
import { ErrorMessage } from "@/cli/components/ErrorMessageRich";
import { EventMessage } from "@/cli/components/EventMessage";
import { ExperimentSelector } from "@/cli/components/ExperimentSelector";
import { FeedbackDialog } from "@/cli/components/FeedbackDialog";
import { HelpDialog } from "@/cli/components/HelpDialog";
import { HooksManager } from "@/cli/components/HooksManager";
import { InlineQuestionApproval } from "@/cli/components/InlineQuestionApproval";
import { Input } from "@/cli/components/InputRich";
import { InstallGithubAppFlow } from "@/cli/components/InstallGithubAppFlow";
import { McpConnectFlow } from "@/cli/components/McpConnectFlow";
import { McpSelector } from "@/cli/components/McpSelector";
import { MemfsTreeViewer } from "@/cli/components/MemfsTreeViewer";
import { MemoryTabViewer } from "@/cli/components/MemoryTabViewer";
import { MessageSearch } from "@/cli/components/MessageSearch";
import { ModelReasoningSelector } from "@/cli/components/ModelReasoningSelector";
import {
  ModelSelector,
  type ModelSelectorSelection,
} from "@/cli/components/ModelSelector";
import { PendingApprovalStub } from "@/cli/components/PendingApprovalStub";
import { PersonalitySelector } from "@/cli/components/PersonalitySelector";
import { PinDialog } from "@/cli/components/PinDialog";
import { ProviderSelector } from "@/cli/components/ProviderSelector";
import { ReasoningMessage } from "@/cli/components/ReasoningMessageRich";
import { SkillsDialog } from "@/cli/components/SkillsDialog";
import { SleeptimeSelector } from "@/cli/components/SleeptimeSelector";
import { StatusMessage } from "@/cli/components/StatusMessage";
import { SubagentGroupDisplay } from "@/cli/components/SubagentGroupDisplay";
import { SubagentManager } from "@/cli/components/SubagentManager";
import { SystemPromptSelector } from "@/cli/components/SystemPromptSelector";
import { Text } from "@/cli/components/Text";
import { ToolCallMessage } from "@/cli/components/ToolCallMessageRich";
import { ToolsetSelector } from "@/cli/components/ToolsetSelector";
import { UserMessage } from "@/cli/components/UserMessageRich";
import { WelcomeScreen } from "@/cli/components/WelcomeScreen";
import { WindowTitlePicker } from "@/cli/components/WindowTitlePicker";
import { WorktreeDiffSelector } from "@/cli/components/WorktreeDiffSelector";
import { AnimationProvider } from "@/cli/contexts/AnimationContext";
import { type Buffers, type Line, toLines } from "@/cli/helpers/accumulator";
import { backfillBuffers } from "@/cli/helpers/backfill";
import {
  type ContextTracker,
  resetContextHistory,
} from "@/cli/helpers/context-tracker";
import type { ConversationSwitchContext } from "@/cli/helpers/conversation-switch-alert";
import type { AdvancedDiffSuccess } from "@/cli/helpers/diff";
import { CLI_GLYPHS } from "@/cli/helpers/glyphs";
import {
  getReflectionSettings,
  type ReflectionSettings,
} from "@/cli/helpers/memory-reminder";
import type { ExecutionPhase } from "@/cli/helpers/phase-visuals";
import type { ReflectionArenaChoiceQuestion } from "@/cli/helpers/reflection-arena";
import type { ApprovalRequest } from "@/cli/helpers/stream";
import {
  isFileEditTool,
  isFileWriteTool,
  isPatchTool,
  isShellTool,
} from "@/cli/helpers/tool-name-mapping";
import { isTaskTool } from "@/cli/helpers/tool-name-mapping.js";
import type { WindowTitleData } from "@/cli/helpers/window-title-config";
import type { ModContext } from "@/cli/mods/types";
import type { LocalModAdapter } from "@/cli/mods/use-local-mod-adapter";
import { experimentManager } from "@/experiments/manager";
import type { ExperimentId } from "@/experiments/types";
import type { ApprovalContext } from "@/permissions/analyzer";
import type { PermissionMode } from "@/permissions/mode";
import { settingsManager } from "@/settings-manager";
import type { ToolsetName, ToolsetPreference } from "@/tools/toolset";
import type { QueuedMessage } from "@/utils/message-queue-bridge";
import { ExitStats } from "./ExitStats";
import { uid } from "./ids";
import { StaticTranscript } from "./StaticTranscript";
import type {
  ActiveOverlay,
  AppCommandRunner,
  AppLoadingState,
  QueuedOverlayAction,
  StaticItem,
} from "./types";

type ModelSelectorOptions = {
  filterProvider?: string;
  forceRefresh?: boolean;
};

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

type QueuedApprovalDecision = {
  type: "approve" | "deny";
  reason?: string;
};

type AppViewProps = {
  activeOverlay: ActiveOverlay;
  agentId: string;
  agentName: string | null;
  agentState: AgentState | null | undefined;
  anySelectorOpen: boolean;
  approvalMap: Map<string, ApprovalRequest>;
  bashRunning: boolean;
  billingTier: string | null;
  btwState: BtwState;
  buffersRef: RefObject<Buffers>;
  chromeColumns: number;
  closeOverlay: () => void;
  columns: number;
  commandRunner: AppCommandRunner;
  completeOverlay: (
    overlay: NonNullable<ActiveOverlay>,
  ) => CommandHandle | null;
  contextTrackerRef: RefObject<ContextTracker>;
  continueSession: boolean;
  conversationId: string;
  conversationSummary: string | null;
  projectDirectory: string;
  currentApproval: ApprovalRequest | undefined;
  currentApprovalContext: ApprovalContext | undefined;
  currentModelDisplay: string | null;
  currentModelHandle: string | null;
  currentModelId: string | null;
  currentModelServiceTier: string | null;
  currentModelProvider: string | null;
  currentPersonalityId: PersonalityId | null;
  currentReasoningEffort: ModelReasoningEffort | null;
  currentSystemPromptId: string | null;
  currentToolset: ToolsetName | null;
  currentToolsetPreference: ToolsetPreference;
  emittedIdsRef: RefObject<Set<string>>;
  expandedToolCallId: string | null;
  lastShellToolCallId: string | null;
  handleCtrlO: () => void;
  queueMode: "immediate" | "defer";
  deferModeSupported: boolean;
  handleCtrlD: () => void;

  feedbackPrefill: string;
  footerUpdateText: string | null;
  showInspirationalPromptHints: boolean;
  onEscapeCommandCancel?: () => boolean;
  handleAgentSelect: (
    targetAgentId: string,
    opts?: {
      profileName?: string;
      conversationId?: string;
      commandId?: string;
      backendMode?: import("@/cli/components/AgentSelector").AgentBackendMode;
    },
  ) => Promise<void>;
  handleApproveAlways: (
    scope?: "project" | "session",
    diffs?: Map<string, AdvancedDiffSuccess>,
  ) => Promise<void>;
  handleApproveCurrent: (
    diffs?: Map<string, AdvancedDiffSuccess>,
  ) => Promise<void>;
  handleBashInterrupt: () => void;
  handleBashSubmit: (command: string) => Promise<void>;
  handleBtwJump: (conversationId: string) => Promise<void>;
  handleCancelApprovals: () => void;
  handleCompactionModeSelect: (
    mode: string,
    commandId?: string | null,
  ) => Promise<void>;
  handleCreateNewAgent: (
    name: string,
    opts?: {
      commandId?: string;
      backendMode?: import("@/cli/components/AgentSelector").AgentBackendMode;
    },
  ) => Promise<void>;
  handleCycleReasoningEffort: () => void;
  handleDenyCurrent: (reason: string) => Promise<void>;
  handleQueueEdit: () => string;
  handleExit: () => Promise<void>;
  handleExperimentsConfirm: (
    changes: Array<{ experimentId: ExperimentId; enabled: boolean }>,
  ) => Promise<void>;
  handleFeedbackSubmit: (message: string) => Promise<void>;
  handleInterrupt: () => Promise<void>;
  handleModelSelect: (
    model: string | ModelSelectorSelection,
    commandId?: string | null,
    opts?: {
      promptReasoning?: boolean;
      skipReasoningPrompt?: boolean;
      reasoningEffort?: ModelReasoningEffort;
    },
  ) => Promise<void>;
  handlePasteError: (message: string) => void;
  handlePermissionModeChange: (mode: PermissionMode) => void;
  handlePersonalitySelect: (
    personalityId: PersonalityId,
    commandId?: string | null,
  ) => Promise<void>;
  handleProfileEscapeCancel: () => void;
  handleQuestionSubmit: (answers: Record<string, string>) => Promise<void>;
  handleReflectionArenaChoiceCancel: () => void;
  handleReflectionArenaChoiceSubmit: (
    answers: Record<string, string>,
  ) => Promise<void>;
  handleSleeptimeModeSelect: (
    reflectionSettings: ReflectionSettings,
    commandId?: string | null,
  ) => Promise<void>;
  handleSystemPromptSelect: (
    promptId: string,
    commandId?: string | null,
  ) => Promise<void>;
  handleToolsetSelect: (
    toolsetId: ToolsetPreference,
    commandId?: string | null,
  ) => Promise<void>;
  hasBackfilledRef: RefObject<boolean>;
  hasTemporaryModelOverride: boolean;
  includeSystemPromptUpgradeTip: boolean;
  inputEnabled: boolean;
  inputVisible: boolean;
  interruptRequested: boolean;
  isAgentBusy: () => boolean;
  liveItems: Line[];
  liveTrajectoryElapsedBaseMs: number;
  loadingState: AppLoadingState;
  markLocalModelsAvailable: () => void;
  maybeCarryOverActiveConversationModel: (
    targetConversationId: string,
  ) => Promise<void>;
  modelReasoningPrompt: ModelReasoningPrompt | null;
  modelSelectorOptions: ModelSelectorOptions;
  networkPhase: "error" | "upload" | "download" | null;
  executionPhase: ExecutionPhase;
  onSubmit: (message?: string) => Promise<{ submitted: boolean }>;
  pendingApprovals: ApprovalRequest[];
  pendingConversationSwitchRef: RefObject<ConversationSwitchContext | null>;
  pendingIds: Set<string>;
  reflectionArenaChoicePending: {
    questions: ReflectionArenaChoiceQuestion[];
    readyMessage?: string;
    runId: string;
  } | null;
  precomputedDiffsRef: RefObject<Map<string, AdvancedDiffSuccess>>;
  profileConfirmPending: {
    name: string;
    agentId: string;
    cmdId: string;
  } | null;
  queueDisplay: QueuedMessage[];
  queuedDecisions: Map<string, QueuedApprovalDecision>;
  queuedIds: Set<string>;
  reasoningTabCycleEnabled: boolean;
  recoverRestoredPendingApprovals: (
    approvals: ApprovalRequest[],
    options?: { notifyOnManualApproval?: boolean },
  ) => Promise<void>;
  refreshDerived: () => void;
  resetBootstrapReminderState: (pendingConversationBootstrap?: boolean) => void;
  resetDeferredToolCallCommits: () => void;
  resetTrajectoryBases: () => void;
  restoredInput: string | null;
  resumeKey: number;
  searchQuery: string;
  sessionStatsRef: RefObject<SessionStats>;
  worktreeDiffSelectorPending: {
    worktrees: import("@/web/worktree-diff-list").WorktreeDiffOption[];
  } | null;
  setWorktreeDiffSelectorPending: Dispatch<
    SetStateAction<{
      worktrees: import("@/web/worktree-diff-list").WorktreeDiffOption[];
    } | null>
  >;
  setActiveOverlay: Dispatch<SetStateAction<ActiveOverlay>>;
  setBtwState: Dispatch<SetStateAction<BtwState>>;
  setCommandRunning: (value: boolean) => void;
  setConversationAutoTitleEligibility: (enabled: boolean) => void;
  setConversationIdAndRef: (nextConversationId: string) => void;
  setConversationSummary: (summary: string | null) => void;
  setLines: Dispatch<SetStateAction<Line[]>>;
  setModelReasoningPrompt: Dispatch<
    SetStateAction<ModelReasoningPrompt | null>
  >;
  setModelSelectorOptions: Dispatch<SetStateAction<ModelSelectorOptions>>;
  setQueuedOverlayAction: Dispatch<SetStateAction<QueuedOverlayAction>>;
  setRestoredInput: Dispatch<SetStateAction<string | null>>;
  setStaticItems: Dispatch<SetStateAction<StaticItem[]>>;
  setStaticRenderEpoch: Dispatch<SetStateAction<number>>;
  shouldAnimate: boolean;
  showApprovalPreview: boolean;
  showCompactionsEnabled: boolean;
  showExitStats: boolean;
  openOverlay: (
    overlay: NonNullable<ActiveOverlay>,
    input: string,
    openingOutput: string,
    dismissOutput: string,
  ) => CommandHandle;
  staticItems: StaticItem[];
  staticRenderEpoch: number;
  modContext: ModContext;
  statusLinePrompt: string;
  terminalTitleData: WindowTitleData;
  onTitlePreview: (title: string | null) => void;
  onTitlePreviewEnd: () => void;
  modAdapter: LocalModAdapter;
  fileAutocompleteFdPath?: string | null;
  streaming: boolean;
  stubDescriptions: Map<string, string>;
  thinkingMessage: string;
  trajectoryTokenDisplay: number;
  usedContextTokens: number;
  contextWindowSize: number | null | undefined;
  uiPermissionMode: PermissionMode;
  updateAgentName: (name: string) => void;
};

export function AppView(props: AppViewProps) {
  const {
    activeOverlay,
    agentId,
    agentName,
    agentState,
    anySelectorOpen,
    approvalMap,
    bashRunning,
    billingTier,
    btwState,
    buffersRef,
    chromeColumns,
    closeOverlay,
    columns,
    commandRunner,
    completeOverlay,
    contextTrackerRef,
    continueSession,
    conversationId,
    projectDirectory,
    currentApproval,
    currentApprovalContext,
    currentModelDisplay,
    currentModelHandle,
    currentModelId,
    currentModelServiceTier,
    currentModelProvider,
    currentPersonalityId,
    currentReasoningEffort,
    currentSystemPromptId,
    currentToolset,
    currentToolsetPreference,
    emittedIdsRef,
    expandedToolCallId,
    lastShellToolCallId,
    handleCtrlO,
    queueMode,
    deferModeSupported,
    handleCtrlD,
    feedbackPrefill,
    footerUpdateText,
    showInspirationalPromptHints,
    onEscapeCommandCancel,
    handleAgentSelect,
    handleApproveAlways,
    handleApproveCurrent,
    handleBashInterrupt,
    handleBashSubmit,
    handleBtwJump,
    handleCancelApprovals,
    handleCompactionModeSelect,
    handleCreateNewAgent,
    handleCycleReasoningEffort,
    handleDenyCurrent,
    handleQueueEdit,
    handleExit,
    handleExperimentsConfirm,
    handleFeedbackSubmit,
    handleInterrupt,
    handleModelSelect,
    handlePasteError,
    handlePermissionModeChange,
    handlePersonalitySelect,
    handleProfileEscapeCancel,
    handleQuestionSubmit,
    handleReflectionArenaChoiceCancel,
    handleReflectionArenaChoiceSubmit,
    handleSleeptimeModeSelect,
    handleSystemPromptSelect,
    handleToolsetSelect,
    hasBackfilledRef,
    hasTemporaryModelOverride,
    includeSystemPromptUpgradeTip,
    inputEnabled,
    inputVisible,
    interruptRequested,
    isAgentBusy,
    liveItems,
    liveTrajectoryElapsedBaseMs,
    loadingState,
    markLocalModelsAvailable,
    maybeCarryOverActiveConversationModel,
    modelReasoningPrompt,
    modelSelectorOptions,
    networkPhase,
    executionPhase,
    fileAutocompleteFdPath,
    onSubmit,
    pendingApprovals,
    pendingConversationSwitchRef,
    pendingIds,
    precomputedDiffsRef,
    profileConfirmPending,
    queueDisplay,
    queuedDecisions,
    queuedIds,
    reflectionArenaChoicePending,
    reasoningTabCycleEnabled,
    recoverRestoredPendingApprovals,
    refreshDerived,
    resetBootstrapReminderState,
    resetDeferredToolCallCommits,
    resetTrajectoryBases,
    restoredInput,
    resumeKey,
    searchQuery,
    sessionStatsRef,
    worktreeDiffSelectorPending,
    setWorktreeDiffSelectorPending,
    setActiveOverlay,
    setBtwState,
    setCommandRunning,
    setConversationAutoTitleEligibility,
    setConversationIdAndRef,
    setConversationSummary,
    setLines,
    setModelReasoningPrompt,
    setModelSelectorOptions,
    setQueuedOverlayAction,
    setRestoredInput,
    setStaticItems,
    setStaticRenderEpoch,
    shouldAnimate,
    showApprovalPreview,
    showCompactionsEnabled,
    showExitStats,
    openOverlay,
    staticItems,
    staticRenderEpoch,
    modContext,
    statusLinePrompt,
    terminalTitleData,
    onTitlePreview,
    onTitlePreviewEnd,
    modAdapter,
    streaming,
    stubDescriptions,
    thinkingMessage,
    trajectoryTokenDisplay,
    usedContextTokens,
    contextWindowSize,
    uiPermissionMode,
    updateAgentName,
  } = props;

  return (
    <Box key={resumeKey} flexDirection="column">
      <StaticTranscript
        renderEpoch={staticRenderEpoch}
        items={staticItems}
        columns={columns}
        statusLinePrompt={statusLinePrompt}
        showCompactionsEnabled={showCompactionsEnabled}
        precomputedDiffs={precomputedDiffsRef.current}
        hiddenToolCallId={expandedToolCallId ?? undefined}
        lastShellToolCallId={lastShellToolCallId ?? undefined}
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
                    if (
                      ln.kind === "tool_call" &&
                      ln.name &&
                      isShellTool(ln.name) &&
                      !isApprovalTracked &&
                      (ln.phase === "streaming" || ln.phase === "ready")
                    ) {
                      return null;
                    }
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
                            onQuestionSubmit={handleQuestionSubmit}
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
                          />
                        ) : ln.kind === "user" ? (
                          <UserMessage line={ln} prompt={statusLinePrompt} />
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
                            isStreaming={streaming}
                            expandedToolCallId={expandedToolCallId}
                            lastShellToolCallId={lastShellToolCallId}
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
                    onQuestionSubmit={handleQuestionSubmit}
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

            {/* Reflection arena choice prompt - merges the selected memory worktree */}
            {reflectionArenaChoicePending && !currentApproval && (
              <Box marginTop={1} flexDirection="column">
                {reflectionArenaChoicePending.readyMessage && (
                  <Text>{reflectionArenaChoicePending.readyMessage}</Text>
                )}
                <InlineQuestionApproval
                  key={reflectionArenaChoicePending.runId}
                  questions={reflectionArenaChoicePending.questions}
                  onSubmit={handleReflectionArenaChoiceSubmit}
                  onCancel={handleReflectionArenaChoiceCancel}
                  isFocused={true}
                />
              </Box>
            )}

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
                usedContextTokens={usedContextTokens}
                contextWindowSize={contextWindowSize}
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
                onCtrlO={handleCtrlO}
                onCtrlD={handleCtrlD}
                queueMode={queueMode}
                deferModeSupported={deferModeSupported}
                interruptRequested={interruptRequested}
                agentId={agentId}
                agentName={agentName}
                currentModel={currentModelDisplay}
                currentModelProvider={currentModelProvider}
                hasTemporaryModelOverride={hasTemporaryModelOverride}
                currentReasoningEffort={currentReasoningEffort}
                fileAutocompleteFdPath={fileAutocompleteFdPath}
                messageQueue={queueDisplay}
                onQueueEdit={handleQueueEdit}
                onEscapeCancel={
                  profileConfirmPending ? handleProfileEscapeCancel : undefined
                }
                onEscapeCommandCancel={onEscapeCommandCancel}
                inputDisabled={btwState.status === "complete"}
                conversationId={conversationId}
                onPasteError={handlePasteError}
                restoredInput={restoredInput}
                onRestoredInputConsumed={() => setRestoredInput(null)}
                networkPhase={networkPhase}
                executionPhase={executionPhase}
                terminalWidth={chromeColumns}
                shouldAnimate={shouldAnimate}
                modContext={modContext}
                modAdapter={modAdapter}
                statusLinePrompt={statusLinePrompt}
                footerNotification={footerUpdateText}
                showInspirationalPromptHints={showInspirationalPromptHints}
              />
            </Box>

            {/* Model Selector - conditionally mounted as overlay */}
            {activeOverlay === "model" &&
              (modelReasoningPrompt ? (
                <ModelReasoningSelector
                  modelLabel={modelReasoningPrompt.modelLabel}
                  options={modelReasoningPrompt.options}
                  initialModelId={modelReasoningPrompt.initialModelId}
                  initialEffort={modelReasoningPrompt.initialEffort}
                  onSelect={(selectedOption) => {
                    setModelReasoningPrompt(null);
                    void handleModelSelect(
                      selectedOption.selection ?? selectedOption.modelId,
                      null,
                      {
                        skipReasoningPrompt: true,
                        reasoningEffort: selectedOption.effort,
                      },
                    );
                  }}
                  onCancel={() => setModelReasoningPrompt(null)}
                />
              ) : (
                <ModelSelector
                  currentModelId={currentModelId ?? undefined}
                  currentModelHandle={currentModelHandle}
                  currentModelServiceTier={currentModelServiceTier}
                  onSelect={(selection) => {
                    void handleModelSelect(selection, null, {
                      promptReasoning: true,
                    });
                  }}
                  onOpenConnect={() => {
                    const overlayCommand = completeOverlay("model");
                    overlayCommand?.finish("Models dialog dismissed", true);
                    openOverlay(
                      "connect",
                      "/connect",
                      "Opening provider selector...",
                      "Connect dialog dismissed",
                    );
                  }}
                  onOpenLogin={() => {
                    const overlayCommand = completeOverlay("model");
                    overlayCommand?.finish("Models dialog dismissed", true);
                    openOverlay(
                      "login",
                      "/login",
                      "Opening login...",
                      "Login dismissed",
                    );
                  }}
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
                memfsEnabled={isActiveMemfsEnabled(agentId)}
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

            {/* Window Title Configurator - for customizing terminal title */}
            {activeOverlay === "window-title" && (
              <WindowTitlePicker
                projectDirectory={projectDirectory}
                titleData={terminalTitleData}
                onTitlePreview={onTitlePreview}
                onTitlePreviewEnd={onTitlePreviewEnd}
                onClose={closeOverlay}
              />
            )}

            {/* GitHub App Installer - setup Letta Code GitHub Action */}
            {activeOverlay === "install-github-app" && (
              <InstallGithubAppFlow
                onComplete={(result) => {
                  const overlayCommand = completeOverlay("install-github-app");

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
                onStartOAuth={async (provider, target, providerName) => {
                  const overlayCommand = completeOverlay("connect");
                  const cmd =
                    overlayCommand ??
                    commandRunner.start("/connect", "Starting connection...");
                  const {
                    handleConnect,
                    setActiveCommandId: setActiveConnectCommandId,
                  } = await import("@/cli/commands/connect");
                  setActiveConnectCommandId(cmd.id);
                  try {
                    await handleConnect(
                      {
                        buffersRef,
                        refreshDerived,
                        setCommandRunning,
                        target,
                        onCodexConnected: (providerName) => {
                          markLocalModelsAvailable();
                          setModelSelectorOptions({
                            filterProvider: providerName,
                            forceRefresh: true,
                          });
                          openOverlay(
                            "model",
                            "/model",
                            "Opening model selector...",
                            "Models dialog dismissed",
                          );
                        },
                      },
                      `/connect ${
                        provider.id === "openai-codex-oauth" ||
                        provider.providerType === "chatgpt_oauth"
                          ? "chatgpt"
                          : provider.id
                      }${providerName ? ` --name ${providerName}` : ""}`,
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
                onConfirm={handleExperimentsConfirm}
                onCancel={closeOverlay}
              />
            )}

            {activeOverlay === "worktree-diff" &&
              worktreeDiffSelectorPending && (
                <WorktreeDiffSelector
                  worktrees={worktreeDiffSelectorPending.worktrees}
                  onSelect={(path) => {
                    setWorktreeDiffSelectorPending(null);
                    const overlayCommand = completeOverlay("worktree-diff");
                    const cmd =
                      overlayCommand ??
                      commandRunner.start(
                        "/experiments",
                        "Opening worktree diff...",
                      );
                    void import("@/web/generate-diff-viewer")
                      .then(({ generateAndOpenDiffViewer }) =>
                        generateAndOpenDiffViewer(path),
                      )
                      .then((result) => {
                        const fileSummary = `${result.fileCount} file${result.fileCount === 1 ? "" : "s"}`;
                        if (result.opened) {
                          cmd.finish(
                            `Opened worktree diff (${fileSummary})`,
                            true,
                          );
                        } else {
                          cmd.finish(
                            `Open manually: ${result.filePath} (${fileSummary})`,
                            true,
                          );
                        }
                      })
                      .catch((err: unknown) => {
                        cmd.finish(
                          `Failed to open diff: ${err instanceof Error ? err.message : String(err)}`,
                          false,
                        );
                      });
                  }}
                  onCancel={() => {
                    setWorktreeDiffSelectorPending(null);
                    closeOverlay();
                  }}
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
                onSelect={async (id, backendMode) => {
                  const overlayCommand = completeOverlay("resume");
                  await handleAgentSelect(id, {
                    commandId: overlayCommand?.id,
                    backendMode,
                  });
                }}
                onLogin={() => {
                  completeOverlay("resume");
                  openOverlay(
                    "login",
                    "/login",
                    "Opening login...",
                    "Login dismissed",
                  );
                }}
                onCancel={closeOverlay}
                onCreateNewAgent={(name: string, backendMode) => {
                  const overlayCommand = completeOverlay("resume");
                  void handleCreateNewAgent(name, {
                    commandId: overlayCommand?.id,
                    backendMode,
                  });
                }}
              />
            )}

            {activeOverlay === "login" && (
              <ConstellationLoginOverlay
                onComplete={() => {
                  const overlayCommand = completeOverlay("login");
                  const cmd =
                    overlayCommand ??
                    commandRunner.start(
                      "/login",
                      "Signed in to Constellation. Switch to a Constellation agent with /agents.",
                    );
                  cmd.finish(
                    "Signed in to Constellation. Switch to a Constellation agent with /agents.",
                    true,
                  );
                }}
                onAlreadyLoggedIn={() => {
                  const overlayCommand = completeOverlay("login");
                  const cmd =
                    overlayCommand ??
                    commandRunner.start(
                      "/login",
                      "Already signed in to Constellation. Run /logout to sign out.",
                    );
                  cmd.finish(
                    "Already signed in to Constellation. Run /logout to sign out.",
                    true,
                  );
                }}
                onCancel={closeOverlay}
              />
            )}

            {/* Conversation Selector - for resuming conversations */}
            {activeOverlay === "conversations" && (
              <ConversationSelector
                agentId={agentId}
                agentName={agentName ?? undefined}
                currentConversationId={conversationId}
                onSelect={async (convId, selectorContext) => {
                  const overlayCommand = completeOverlay("conversations");

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
                      setConversationSummary(selectorContext?.summary ?? null);

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
                              `${CLI_GLYPHS.result}  Agent: ${agentId}`,
                              `${CLI_GLYPHS.result}  Conversation: ${convId}`,
                            ]
                          : [
                              `Switched to conversation with "${currentAgentName}"`,
                              `${CLI_GLYPHS.result}  Agent: ${agentId}`,
                              `${CLI_GLYPHS.result}  Conversation: ${convId} (empty)`,
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
                  const overlayCommand = completeOverlay("conversations");

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
                    });

                    await maybeCarryOverActiveConversationModel(
                      conversation.id,
                    );
                    setConversationIdAndRef(conversation.id);
                    setConversationAutoTitleEligibility(true);
                    setConversationSummary(null);
                    settingsManager.persistSession(agentId, conversation.id);

                    // Build success command with agent + conversation info
                    const currentAgentName =
                      agentState?.name || "Unnamed Agent";
                    const shortConvId = conversation.id.slice(0, 20);
                    const successLines = [
                      `Started new conversation with "${currentAgentName}"`,
                      `${CLI_GLYPHS.result}  Agent: ${agentId}`,
                      `${CLI_GLYPHS.result}  Conversation: ${shortConvId}... (new)`,
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
                    resetBootstrapReminderState(true);
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
                  const overlayCommand = completeOverlay("search");

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
                        `${CLI_GLYPHS.result}  Conversation: ${actualTargetConv}`,
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
              (isActiveMemfsEnabled(agentId) ? (
                <MemfsTreeViewer
                  agentId={agentId}
                  agentName={agentState?.name}
                  onClose={closeOverlay}
                  conversationId={conversationId}
                  contextUsage={
                    usedContextTokens > 0
                      ? {
                          usedTokens: usedContextTokens,
                          contextWindow: contextWindowSize ?? 0,
                          model:
                            currentModelHandle ??
                            currentModelDisplay ??
                            "unknown",
                        }
                      : undefined
                  }
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
                  const overlayCommand = completeOverlay("mcp-connect");
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

            {/* Pin Dialog - for naming agent before pinning */}
            {activeOverlay === "pin" && (
              <PinDialog
                currentName={agentName || ""}
                onSubmit={async (newName) => {
                  const overlayCommand = completeOverlay("pin");
                  setCommandRunning(true);

                  const cmd =
                    overlayCommand ??
                    commandRunner.start("/pin", "Pinning agent...");
                  const displayName =
                    newName || agentName || agentId.slice(0, 12);

                  cmd.update({
                    output: `Pinning "${displayName}"...`,
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

                    const pinStatus = await pinAgentForCurrentUser(agentId);

                    if (newName && newName !== agentName) {
                      cmd.agentHint = `Your name is now "${newName}" — acknowledge this and save your new name to memory.`;
                    }
                    if (pinStatus === "already-pinned") {
                      cmd.finish("This agent is already pinned.", false);
                      return;
                    }
                    cmd.finish(
                      `Pinned "${newName || agentName || agentId.slice(0, 12)}".`,
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

            {/* AskUserQuestion now rendered inline via InlineQuestionApproval */}
            {/* ApprovalDialog removed - all approvals now render inline via InlineGenericApproval fallback */}
          </>
        )}
      </Box>
    </Box>
  );
}
