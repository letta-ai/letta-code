// src/cli/App.tsx

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { APIUserAbortError } from "@letta-ai/letta-client/core/error";
import type {
  AgentState,
  MessageCreate,
} from "@letta-ai/letta-client/resources/agents/agents";
import type {
  ApprovalCreate,
  Message,
} from "@letta-ai/letta-client/resources/agents/messages";
import type { LlmConfig } from "@letta-ai/letta-client/resources/models/models";
import { Box, Static, Text } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ApprovalResult } from "../agent/approval-execution";
import { getResumeData } from "../agent/check-approval";
import { getClient } from "../agent/client";
import { setCurrentAgentId } from "../agent/context";
import type { AgentProvenance } from "../agent/create";
import { sendMessageStream } from "../agent/message";
import { linkToolsToAgent, unlinkToolsFromAgent } from "../agent/modify";
import { SessionStats } from "../agent/stats";
import type { ApprovalContext } from "../permissions/analyzer";
import { permissionMode } from "../permissions/mode";
import { updateProjectSettings } from "../settings";
import { settingsManager } from "../settings-manager";
import type { ToolExecutionResult } from "../tools/manager";
import {
  analyzeToolApproval,
  checkToolPermission,
  executeTool,
  savePermissionRule,
} from "../tools/manager";
import {
  addCommandResult,
  handlePin,
  handleProfileDelete,
  handleProfileSave,
  handleProfileUsage,
  handleUnpin,
  type ProfileCommandContext,
  validateProfileLoad,
} from "./commands/profile";
import { AgentSelector } from "./components/AgentSelector";
import { ApprovalDialog } from "./components/ApprovalDialogRich";
import { AssistantMessage } from "./components/AssistantMessageRich";
import { CommandMessage } from "./components/CommandMessage";
import { EnterPlanModeDialog } from "./components/EnterPlanModeDialog";
import { ErrorMessage } from "./components/ErrorMessageRich";
import { Input } from "./components/InputRich";
import { MessageSearch } from "./components/MessageSearch";
import { ModelSelector } from "./components/ModelSelector";
import { PlanModeDialog } from "./components/PlanModeDialog";
import { ProfileSelector } from "./components/ProfileSelector";
import { QuestionDialog } from "./components/QuestionDialog";
import { ReasoningMessage } from "./components/ReasoningMessageRich";
import { ResumeSelector } from "./components/ResumeSelector";
import { SessionStats as SessionStatsComponent } from "./components/SessionStats";
import { StatusMessage } from "./components/StatusMessage";
import { SubagentGroupDisplay } from "./components/SubagentGroupDisplay";
import { SubagentGroupStatic } from "./components/SubagentGroupStatic";
import { SubagentManager } from "./components/SubagentManager";
import { SystemPromptSelector } from "./components/SystemPromptSelector";
import { ToolCallMessage } from "./components/ToolCallMessageRich";
import { ToolsetSelector } from "./components/ToolsetSelector";
import { UserMessage } from "./components/UserMessageRich";
import { getAgentStatusHints, WelcomeScreen } from "./components/WelcomeScreen";
import {
  type Buffers,
  createBuffers,
  type Line,
  markIncompleteToolsAsCancelled,
  onChunk,
  toLines,
} from "./helpers/accumulator";
import { backfillBuffers } from "./helpers/backfill";
import { formatErrorDetails } from "./helpers/errorFormatter";
import {
  buildMessageContentFromDisplay,
  clearPlaceholdersInText,
} from "./helpers/pasteRegistry";
import { generatePlanFilePath } from "./helpers/planName";
import { safeJsonParseOr } from "./helpers/safeJsonParse";
import { type ApprovalRequest, drainStreamWithResume } from "./helpers/stream";
import {
  collectFinishedTaskToolCalls,
  createSubagentGroupItem,
  hasInProgressTaskToolCalls,
} from "./helpers/subagentAggregation";
import {
  clearCompletedSubagents,
  clearSubagentsByIds,
} from "./helpers/subagentState";
import { getRandomThinkingMessage } from "./helpers/thinkingMessages";
import { isFancyUITool, isTaskTool } from "./helpers/toolNameMapping.js";
import { useSuspend } from "./hooks/useSuspend/useSuspend.ts";
import { useTerminalWidth } from "./hooks/useTerminalWidth";

const CLEAR_SCREEN_AND_HOME = "\u001B[2J\u001B[H";

// Feature flag: Check for pending approvals before sending messages
// This prevents infinite thinking state when there's an orphaned approval
// Can be disabled if the latency check adds too much overhead
const CHECK_PENDING_APPROVALS_BEFORE_SEND = true;

// Feature flag: Eagerly cancel streams client-side when user presses ESC
// When true (default), immediately abort the stream after calling .cancel()
// This provides instant feedback to the user without waiting for backend acknowledgment
// When false, wait for backend to send "cancelled" stop_reason (useful for testing backend behavior)
const EAGER_CANCEL = true;

// tiny helper for unique ids (avoid overwriting prior user lines)
function uid(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Get plan mode system reminder if in plan mode
function getPlanModeReminder(): string {
  if (permissionMode.getMode() !== "plan") {
    return "";
  }

  const planFilePath = permissionMode.getPlanFilePath();

  // Generate dynamic reminder with plan file path
  return `<system-reminder>
Plan mode is active. The user indicated that they do not want you to execute yet -- you MUST NOT make any edits (with the exception of the plan file mentioned below), run any non-readonly tools (including changing configs or making commits), or otherwise make any changes to the system. This supercedes any other instructions you have received.

## Plan File Info:
${planFilePath ? `No plan file exists yet. You should create your plan at ${planFilePath} using the Write tool.` : "No plan file path assigned."}

You should build your plan incrementally by writing to or editing this file. NOTE that this is the only file you are allowed to edit - other than this you are only allowed to take READ-ONLY actions.

**Plan File Guidelines:** The plan file should contain only your final recommended approach, not all alternatives considered. Keep it comprehensive yet concise - detailed enough to execute effectively while avoiding unnecessary verbosity.

## Enhanced Planning Workflow

### Phase 1: Initial Understanding
Goal: Gain a comprehensive understanding of the user's request by reading through code and asking them questions.

1. Understand the user's request thoroughly
2. Explore the codebase to understand existing patterns and relevant code
3. Use AskUserQuestion tool to clarify ambiguities in the user request up front.

### Phase 2: Planning
Goal: Come up with an approach to solve the problem identified in phase 1.

- Provide any background context that may help with the task without prescribing the exact design itself
- Create a detailed plan

### Phase 3: Synthesis
Goal: Synthesize the perspectives from Phase 2, and ensure that it aligns with the user's intentions by asking them questions.

1. Collect all findings from exploration
2. Keep track of critical files that should be read before implementing the plan
3. Use AskUserQuestion to ask the user questions about trade offs.

### Phase 4: Final Plan
Once you have all the information you need, ensure that the plan file has been updated with your synthesized recommendation including:

- Recommended approach with rationale
- Key insights from different perspectives
- Critical files that need modification

### Phase 5: Call ExitPlanMode
At the very end of your turn, once you have asked the user questions and are happy with your final plan file - you should always call ExitPlanMode to indicate to the user that you are done planning.

This is critical - your turn should only end with either asking the user a question or calling ExitPlanMode. Do not stop unless it's for these 2 reasons.

NOTE: At any point in time through this workflow you should feel free to ask the user questions or clarifications. Don't make large assumptions about user intent. The goal is to present a well researched plan to the user, and tie any loose ends before implementation begins.
</system-reminder>
`;
}

// Check if plan file exists
function planFileExists(): boolean {
  const planFilePath = permissionMode.getPlanFilePath();
  return !!planFilePath && existsSync(planFilePath);
}

// Read plan content from the plan file
function readPlanFile(): string {
  const planFilePath = permissionMode.getPlanFilePath();
  if (!planFilePath) {
    return "No plan file path set.";
  }
  if (!existsSync(planFilePath)) {
    return `Plan file not found at ${planFilePath}`;
  }
  try {
    return readFileSync(planFilePath, "utf-8");
  } catch {
    return `Failed to read plan file at ${planFilePath}`;
  }
}

// Extract questions from AskUserQuestion tool args
function getQuestionsFromApproval(approval: ApprovalRequest) {
  const parsed = safeJsonParseOr<Record<string, unknown>>(
    approval.toolArgs,
    {},
  );
  return (
    (parsed.questions as Array<{
      question: string;
      header: string;
      options: Array<{ label: string; description: string }>;
      multiSelect: boolean;
    }>) || []
  );
}

// Get skill unload reminder if skills are loaded (using cached flag)
function getSkillUnloadReminder(): string {
  const { hasLoadedSkills } = require("../agent/context");
  if (hasLoadedSkills()) {
    const { SKILL_UNLOAD_REMINDER } = require("../agent/promptAssets");
    return SKILL_UNLOAD_REMINDER;
  }
  return "";
}

// Items that have finished rendering and no longer change
type StaticItem =
  | {
      kind: "welcome";
      id: string;
      snapshot: {
        continueSession: boolean;
        agentState?: AgentState | null;
        agentProvenance?: AgentProvenance | null;
        terminalWidth: number;
      };
    }
  | {
      kind: "subagent_group";
      id: string;
      agents: Array<{
        id: string;
        type: string;
        description: string;
        status: "completed" | "error";
        toolCount: number;
        totalTokens: number;
        agentURL: string | null;
        error?: string;
      }>;
    }
  | Line;

export default function App({
  agentId: initialAgentId,
  agentState: initialAgentState,
  loadingState = "ready",
  continueSession = false,
  startupApproval = null,
  startupApprovals = [],
  messageHistory = [],
  tokenStreaming = false,
  agentProvenance = null,
}: {
  agentId: string;
  agentState?: AgentState | null;
  loadingState?:
    | "assembling"
    | "upserting"
    | "linking"
    | "unlinking"
    | "importing"
    | "initializing"
    | "checking"
    | "ready";
  continueSession?: boolean;
  startupApproval?: ApprovalRequest | null; // Deprecated: use startupApprovals
  startupApprovals?: ApprovalRequest[];
  messageHistory?: Message[];
  tokenStreaming?: boolean;
  agentProvenance?: AgentProvenance | null;
}) {
  // Track current agent (can change when swapping)
  const [agentId, setAgentId] = useState(initialAgentId);
  const [agentState, setAgentState] = useState(initialAgentState);

  // Keep a ref to the current agentId for use in callbacks that need the latest value
  const agentIdRef = useRef(agentId);
  useEffect(() => {
    agentIdRef.current = agentId;
  }, [agentId]);

  const resumeKey = useSuspend();

  // Track previous prop values to detect actual prop changes (not internal state changes)
  const prevInitialAgentIdRef = useRef(initialAgentId);
  const prevInitialAgentStateRef = useRef(initialAgentState);

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

  // Set agent context for tools (especially Task tool)
  useEffect(() => {
    if (agentId) {
      setCurrentAgentId(agentId);
    }
  }, [agentId]);

  // Whether a stream is in flight (disables input)
  const [streaming, setStreaming] = useState(false);

  // Whether an interrupt has been requested for the current stream
  const [interruptRequested, setInterruptRequested] = useState(false);

  // Whether a command is running (disables input but no streaming UI)
  const [commandRunning, setCommandRunning] = useState(false);

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
  const toolAbortControllerRef = useRef<AbortController | null>(null);

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

  // Derive current approval from pending approvals and results
  // This is the approval currently being shown to the user
  const currentApproval = pendingApprovals[approvalResults.length];

  // Model selector state
  const [modelSelectorOpen, setModelSelectorOpen] = useState(false);
  const [toolsetSelectorOpen, setToolsetSelectorOpen] = useState(false);
  const [systemPromptSelectorOpen, setSystemPromptSelectorOpen] =
    useState(false);
  const [currentSystemPromptId, setCurrentSystemPromptId] = useState<
    string | null
  >("default");
  const [currentToolset, setCurrentToolset] = useState<
    "codex" | "codex_snake" | "default" | "gemini" | "gemini_snake" | null
  >(null);
  const [llmConfig, setLlmConfig] = useState<LlmConfig | null>(null);
  const [agentName, setAgentName] = useState<string | null>(null);
  const [agentDescription, setAgentDescription] = useState<string | null>(null);
  const [agentLastRunAt, setAgentLastRunAt] = useState<string | null>(null);
  const currentModelLabel =
    llmConfig?.model_endpoint_type && llmConfig?.model
      ? `${llmConfig.model_endpoint_type}/${llmConfig.model}`
      : (llmConfig?.model ?? null);
  const currentModelDisplay = currentModelLabel?.split("/").pop() ?? null;

  // Agent selector state
  const [agentSelectorOpen, setAgentSelectorOpen] = useState(false);

  // Resume selector state
  const [resumeSelectorOpen, setResumeSelectorOpen] = useState(false);
  const [messageSearchOpen, setMessageSearchOpen] = useState(false);

  // Subagent manager state (for /subagents command)
  const [subagentManagerOpen, setSubagentManagerOpen] = useState(false);

  // Profile selector state
  const [profileSelectorOpen, setProfileSelectorOpen] = useState(false);

  // Token streaming preference (can be toggled at runtime)
  const [tokenStreamingEnabled, setTokenStreamingEnabled] =
    useState(tokenStreaming);

  // Live, approximate token counter (resets each turn)
  const [tokenCount, setTokenCount] = useState(0);

  // Current thinking message (rotates each turn)
  const [thinkingMessage, setThinkingMessage] = useState(
    getRandomThinkingMessage(),
  );

  // Session stats tracking
  const sessionStatsRef = useRef(new SessionStats());

  // Track if we've sent the session context for this CLI session
  const hasSentSessionContextRef = useRef(false);

  // Show exit stats on exit
  const [showExitStats, setShowExitStats] = useState(false);

  // Static items (things that are done rendering and can be frozen)
  const [staticItems, setStaticItems] = useState<StaticItem[]>([]);

  // Track committed ids to avoid duplicates
  const emittedIdsRef = useRef<Set<string>>(new Set());

  // Guard to append welcome snapshot only once
  const welcomeCommittedRef = useRef(false);

  // AbortController for stream cancellation
  const abortControllerRef = useRef<AbortController | null>(null);

  // Track if user wants to cancel (persists across state updates)
  const userCancelledRef = useRef(false);

  // Message queue state for queueing messages during streaming
  const [messageQueue, setMessageQueue] = useState<string[]>([]);

  // Queue cancellation: when any message is queued, we send cancel and wait for stream to end
  const waitingForQueueCancelRef = useRef(false);
  const queueSnapshotRef = useRef<string[]>([]);
  const [restoreQueueOnCancel, setRestoreQueueOnCancel] = useState(false);
  const restoreQueueOnCancelRef = useRef(restoreQueueOnCancel);
  useEffect(() => {
    restoreQueueOnCancelRef.current = restoreQueueOnCancel;
  }, [restoreQueueOnCancel]);

  // Track terminal shrink events to refresh static output (prevents wrapped leftovers)
  const columns = useTerminalWidth();
  const prevColumnsRef = useRef(columns);
  const [staticRenderEpoch, setStaticRenderEpoch] = useState(0);
  useEffect(() => {
    const prev = prevColumnsRef.current;
    if (columns === prev) return;

    if (
      columns < prev &&
      typeof process !== "undefined" &&
      process.stdout &&
      "write" in process.stdout &&
      process.stdout.isTTY
    ) {
      process.stdout.write(CLEAR_SCREEN_AND_HOME);
    }

    setStaticRenderEpoch((epoch) => epoch + 1);
    prevColumnsRef.current = columns;
  }, [columns]);

  // Commit immutable/finished lines into the historical log
  const commitEligibleLines = useCallback((b: Buffers) => {
    const newlyCommitted: StaticItem[] = [];
    let firstTaskIndex = -1;

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
      if (ln.kind === "user" || ln.kind === "error" || ln.kind === "status") {
        emittedIdsRef.current.add(id);
        newlyCommitted.push({ ...ln });
        continue;
      }
      // Commands with phase should only commit when finished
      if (ln.kind === "command") {
        if (!ln.phase || ln.phase === "finished") {
          emittedIdsRef.current.add(id);
          newlyCommitted.push({ ...ln });
        }
        continue;
      }
      // Handle Task tool_calls specially - track position but don't add individually
      if (ln.kind === "tool_call" && ln.name && isTaskTool(ln.name)) {
        if (firstTaskIndex === -1 && finishedTaskToolCalls.length > 0) {
          firstTaskIndex = newlyCommitted.length;
        }
        continue;
      }
      if ("phase" in ln && ln.phase === "finished") {
        emittedIdsRef.current.add(id);
        newlyCommitted.push({ ...ln });
      }
    }

    // If we collected Task tool_calls (all are finished), create a subagent_group
    if (finishedTaskToolCalls.length > 0) {
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

    if (newlyCommitted.length > 0) {
      setStaticItems((prev) => [...prev, ...newlyCommitted]);
    }
  }, []);

  // Render-ready transcript
  const [lines, setLines] = useState<Line[]>([]);

  // Canonical buffers stored in a ref (mutated by onChunk), PERSISTED for session
  const buffersRef = useRef(createBuffers());

  // Track whether we've already backfilled history (should only happen once)
  const hasBackfilledRef = useRef(false);

  // Recompute UI state from buffers after chunks (micro-batched)
  const refreshDerived = useCallback(() => {
    const b = buffersRef.current;
    setTokenCount(b.tokenCount);
    const newLines = toLines(b);
    setLines(newLines);
    commitEligibleLines(b);
  }, [commitEligibleLines]);

  // Throttled version for streaming updates (~60fps max)
  const refreshDerivedThrottled = useCallback(() => {
    // Use a ref to track pending refresh
    if (!buffersRef.current.pendingRefresh) {
      buffersRef.current.pendingRefresh = true;
      setTimeout(() => {
        buffersRef.current.pendingRefresh = false;
        refreshDerived();
      }, 16); // ~60fps
    }
  }, [refreshDerived]);

  // Restore pending approval from startup when ready
  // All approvals (including fancy UI tools) go through pendingApprovals
  // The render logic determines which UI to show based on tool name
  useEffect(() => {
    // Use new plural field if available, otherwise wrap singular in array for backward compat
    const approvals =
      startupApprovals?.length > 0
        ? startupApprovals
        : startupApproval
          ? [startupApproval]
          : [];

    if (loadingState === "ready" && approvals.length > 0) {
      // All approvals go through the same flow - UI rendering decides which dialog to show
      setPendingApprovals(approvals);

      // Analyze approval contexts for all restored approvals
      const analyzeStartupApprovals = async () => {
        try {
          const contexts = await Promise.all(
            approvals.map(async (approval) => {
              const parsedArgs = safeJsonParseOr<Record<string, unknown>>(
                approval.toolArgs,
                {},
              );
              return await analyzeToolApproval(approval.toolName, parsedArgs);
            }),
          );
          setApprovalContexts(contexts);
        } catch (error) {
          // If analysis fails, leave context as null (will show basic options)
          console.error("Failed to analyze startup approvals:", error);
        }
      };

      analyzeStartupApprovals();
    }
  }, [loadingState, startupApproval, startupApprovals]);

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
      const cwd = process.cwd();
      const shortCwd = cwd.startsWith(process.env.HOME || "")
        ? `~${cwd.slice((process.env.HOME || "").length)}`
        : cwd;
      const agentUrl = agentState?.id
        ? `https://app.letta.com/agents/${agentState.id}`
        : null;
      const statusLines = [
        `Connecting to last used agent in ${shortCwd}`,
        agentState?.name ? `→ Agent: ${agentState.name}` : "",
        agentUrl ? `→ ${agentUrl}` : "",
        "→ Use /pinned or /resume to switch agents",
      ].filter(Boolean);
      buffersRef.current.byId.set(statusId, {
        kind: "status",
        id: statusId,
        lines: statusLines,
      });
      buffersRef.current.order.push(statusId);

      refreshDerived();
      commitEligibleLines(buffersRef.current);
    }
  }, [
    loadingState,
    messageHistory,
    refreshDerived,
    commitEligibleLines,
    continueSession,
    columns,
    agentState,
    agentProvenance,
  ]);

  // Fetch llmConfig when agent is ready
  useEffect(() => {
    if (loadingState === "ready" && agentId && agentId !== "loading") {
      const fetchConfig = async () => {
        try {
          const { getClient } = await import("../agent/client");
          const client = await getClient();
          const agent = await client.agents.retrieve(agentId);
          setLlmConfig(agent.llm_config);
          setAgentName(agent.name);
          setAgentDescription(agent.description ?? null);
          // Get last message timestamp from agent state if available
          const lastRunCompletion = (agent as { last_run_completion?: string })
            .last_run_completion;
          setAgentLastRunAt(lastRunCompletion ?? null);

          // Detect current toolset from attached tools
          const { detectToolsetFromAgent } = await import("../tools/toolset");
          const detected = await detectToolsetFromAgent(client, agentId);
          if (detected) {
            setCurrentToolset(detected);
          }
        } catch (error) {
          console.error("Error fetching agent config:", error);
        }
      };
      fetchConfig();
    }
  }, [loadingState, agentId]);

  // Helper to append an error to the transcript
  const appendError = useCallback(
    (message: string) => {
      const id = uid("err");
      buffersRef.current.byId.set(id, {
        kind: "error",
        id,
        text: message,
      });
      buffersRef.current.order.push(id);
      refreshDerived();
    },
    [refreshDerived],
  );

  // Core streaming function - iterative loop that processes conversation turns
  const processConversation = useCallback(
    async (
      initialInput: Array<MessageCreate | ApprovalCreate>,
    ): Promise<void> => {
      const currentInput = initialInput;

      try {
        // Check if user hit escape before we started
        if (userCancelledRef.current) {
          userCancelledRef.current = false; // Reset for next time
          return;
        }

        setStreaming(true);
        abortControllerRef.current = new AbortController();

        // Clear any stale pending tool calls from previous turns
        // If we're sending a new message, old pending state is no longer relevant
        markIncompleteToolsAsCancelled(buffersRef.current);

        // Clear completed subagents from the UI when starting a new turn
        clearCompletedSubagents();

        while (true) {
          // Check if cancelled before starting new stream
          if (abortControllerRef.current?.signal.aborted) {
            setStreaming(false);
            return;
          }

          // Stream one turn - use ref to always get the latest agentId
          const stream = await sendMessageStream(
            agentIdRef.current,
            currentInput,
          );
          const { stopReason, approval, approvals, apiDurationMs, lastRunId } =
            await drainStreamWithResume(
              stream,
              buffersRef.current,
              refreshDerivedThrottled,
              abortControllerRef.current?.signal,
            );

          // Track API duration
          sessionStatsRef.current.endTurn(apiDurationMs);
          sessionStatsRef.current.updateUsageFromBuffers(buffersRef.current);

          // Immediate refresh after stream completes to show final state
          refreshDerived();

          // Case 1: Turn ended normally
          if (stopReason === "end_turn") {
            setStreaming(false);

            // Check if we were waiting for cancel but stream finished naturally
            if (waitingForQueueCancelRef.current) {
              if (restoreQueueOnCancelRef.current) {
                // User hit ESC during queue cancel - abort the auto-send
                setRestoreQueueOnCancel(false);
                // Don't clear queue, don't send - let dequeue effect handle them one by one
              } else {
                // Auto-send concatenated message
                // Clear the queue
                setMessageQueue([]);

                // Concatenate the snapshot
                const concatenatedMessage = queueSnapshotRef.current.join("\n");

                if (concatenatedMessage.trim()) {
                  onSubmitRef.current(concatenatedMessage);
                }
              }

              // Reset flags
              waitingForQueueCancelRef.current = false;
              queueSnapshotRef.current = [];
            }

            return;
          }

          // Case 1.5: Stream was cancelled by user
          if (stopReason === "cancelled") {
            setStreaming(false);

            // Check if this cancel was triggered by queue threshold
            if (waitingForQueueCancelRef.current) {
              if (restoreQueueOnCancelRef.current) {
                // User hit ESC during queue cancel - abort the auto-send
                setRestoreQueueOnCancel(false);
                // Don't clear queue, don't send - let dequeue effect handle them one by one
              } else {
                // Auto-send concatenated message
                // Clear the queue
                setMessageQueue([]);

                // Concatenate the snapshot
                const concatenatedMessage = queueSnapshotRef.current.join("\n");

                if (concatenatedMessage.trim()) {
                  onSubmitRef.current(concatenatedMessage);
                }
              }

              // Reset flags
              waitingForQueueCancelRef.current = false;
              queueSnapshotRef.current = [];
            } else {
              // Regular user cancellation - show error
              if (!EAGER_CANCEL) {
                appendError("Stream interrupted by user");
              }
            }

            return;
          }

          // Case 2: Requires approval
          if (stopReason === "requires_approval") {
            // Clear stale state immediately to prevent ID mismatch bugs
            setAutoHandledResults([]);
            setAutoDeniedApprovals([]);

            // Use new approvals array, fallback to legacy approval for backward compat
            const approvalsToProcess =
              approvals && approvals.length > 0
                ? approvals
                : approval
                  ? [approval]
                  : [];

            if (approvalsToProcess.length === 0) {
              appendError(
                `Unexpected empty approvals with stop reason: ${stopReason}`,
              );
              setStreaming(false);
              return;
            }

            // If in quietCancel mode (user queued messages), auto-reject all approvals
            // and send denials + queued messages together
            if (waitingForQueueCancelRef.current) {
              if (restoreQueueOnCancelRef.current) {
                // User hit ESC during queue cancel - abort the auto-send
                setRestoreQueueOnCancel(false);
                // Don't clear queue, don't send - let dequeue effect handle them one by one
              } else {
                // Create denial results for all approvals
                const denialResults = approvalsToProcess.map(
                  (approvalItem) => ({
                    type: "approval" as const,
                    tool_call_id: approvalItem.toolCallId,
                    approve: false,
                    reason: "User cancelled - new message queued",
                  }),
                );

                // Update buffers to show tools as cancelled
                for (const approvalItem of approvalsToProcess) {
                  onChunk(buffersRef.current, {
                    message_type: "tool_return_message",
                    id: "dummy",
                    date: new Date().toISOString(),
                    tool_call_id: approvalItem.toolCallId,
                    tool_return: "Cancelled - user sent new message",
                    status: "error",
                  });
                }
                refreshDerived();

                // Queue denial results to be sent with the queued message
                setQueuedApprovalResults(denialResults);

                // Get queued messages and clear queue
                const concatenatedMessage = queueSnapshotRef.current.join("\n");
                setMessageQueue([]);

                // Send via onSubmit which will combine queuedApprovalResults + message
                if (concatenatedMessage.trim()) {
                  onSubmitRef.current(concatenatedMessage);
                }
              }

              // Reset flags
              waitingForQueueCancelRef.current = false;
              queueSnapshotRef.current = [];
              setStreaming(false);
              return;
            }

            // Check permissions for all approvals (including fancy UI tools)
            const approvalResults = await Promise.all(
              approvalsToProcess.map(async (approvalItem) => {
                // Check if approval is incomplete (missing name)
                // Note: toolArgs can be empty string for tools with no arguments (e.g., EnterPlanMode)
                if (!approvalItem.toolName) {
                  return {
                    approval: approvalItem,
                    permission: {
                      decision: "deny" as const,
                      reason:
                        "Tool call incomplete - missing name or arguments",
                    },
                    context: null,
                  };
                }

                const parsedArgs = safeJsonParseOr<Record<string, unknown>>(
                  approvalItem.toolArgs,
                  {},
                );
                const permission = await checkToolPermission(
                  approvalItem.toolName,
                  parsedArgs,
                );
                const context = await analyzeToolApproval(
                  approvalItem.toolName,
                  parsedArgs,
                );
                return { approval: approvalItem, permission, context };
              }),
            );

            // Categorize approvals by permission decision
            // Fancy UI tools should always go through their dialog, even if auto-allowed
            const needsUserInput: typeof approvalResults = [];
            const autoDenied: typeof approvalResults = [];
            const autoAllowed: typeof approvalResults = [];

            for (const ac of approvalResults) {
              const { approval, permission } = ac;
              let decision = permission.decision;

              // Fancy tools should always go through a UI dialog in interactive mode,
              // even if a rule says "allow". Deny rules are still respected.
              if (isFancyUITool(approval.toolName) && decision === "allow") {
                decision = "ask";
              }

              if (decision === "ask") {
                needsUserInput.push(ac);
              } else if (decision === "deny") {
                autoDenied.push(ac);
              } else {
                // decision === "allow"
                autoAllowed.push(ac);
              }
            }

            // Execute auto-allowed tools
            const autoAllowedResults = await Promise.all(
              autoAllowed.map(async (ac) => {
                const parsedArgs = safeJsonParseOr<Record<string, unknown>>(
                  ac.approval.toolArgs,
                  {},
                );
                const result = await executeTool(
                  ac.approval.toolName,
                  parsedArgs,
                  { toolCallId: ac.approval.toolCallId },
                );

                // Update buffers with tool return for UI
                onChunk(buffersRef.current, {
                  message_type: "tool_return_message",
                  id: "dummy",
                  date: new Date().toISOString(),
                  tool_call_id: ac.approval.toolCallId,
                  tool_return: result.toolReturn,
                  status: result.status,
                  stdout: result.stdout,
                  stderr: result.stderr,
                });

                return {
                  toolCallId: ac.approval.toolCallId,
                  result,
                };
              }),
            );

            // Create denial results for auto-denied tools and update buffers
            const autoDeniedResults = autoDenied.map((ac) => {
              const reason =
                "matchedRule" in ac.permission && ac.permission.matchedRule
                  ? `Permission denied by rule: ${ac.permission.matchedRule}`
                  : `Permission denied: ${ac.permission.reason || "Unknown reason"}`;

              // Update buffers with tool rejection for UI
              onChunk(buffersRef.current, {
                message_type: "tool_return_message",
                id: "dummy",
                date: new Date().toISOString(),
                tool_call_id: ac.approval.toolCallId,
                tool_return: `Error: request to call tool denied. User reason: ${reason}`,
                status: "error",
                stdout: null,
                stderr: null,
              });

              return {
                approval: ac.approval,
                reason,
              };
            });

            // If all are auto-handled, continue immediately without showing dialog
            if (needsUserInput.length === 0) {
              // Check if user cancelled before continuing
              if (
                userCancelledRef.current ||
                abortControllerRef.current?.signal.aborted
              ) {
                setStreaming(false);
                markIncompleteToolsAsCancelled(buffersRef.current);
                refreshDerived();
                return;
              }

              // Combine auto-allowed results + auto-denied responses
              const allResults = [
                ...autoAllowedResults.map((ar) => ({
                  type: "tool" as const,
                  tool_call_id: ar.toolCallId,
                  tool_return: ar.result.toolReturn,
                  status: ar.result.status,
                  stdout: ar.result.stdout,
                  stderr: ar.result.stderr,
                })),
                ...autoDeniedResults.map((ad) => ({
                  type: "approval" as const,
                  tool_call_id: ad.approval.toolCallId,
                  approve: false,
                  reason: ad.reason,
                })),
              ];

              // Check if user queued messages during auto-allowed tool execution
              if (waitingForQueueCancelRef.current) {
                if (restoreQueueOnCancelRef.current) {
                  // User hit ESC during queue cancel - abort the auto-send
                  setRestoreQueueOnCancel(false);
                } else {
                  // Queue results to be sent with the queued message
                  setQueuedApprovalResults(allResults);

                  // Get queued messages and clear queue
                  const concatenatedMessage =
                    queueSnapshotRef.current.join("\n");
                  setMessageQueue([]);

                  // Send via onSubmit
                  if (concatenatedMessage.trim()) {
                    onSubmitRef.current(concatenatedMessage);
                  }
                }

                // Reset flags
                waitingForQueueCancelRef.current = false;
                queueSnapshotRef.current = [];
                setStreaming(false);
                return;
              }

              // Rotate to a new thinking message
              setThinkingMessage(getRandomThinkingMessage());
              refreshDerived();

              await processConversation([
                {
                  type: "approval",
                  approvals: allResults,
                },
              ]);
              return;
            }

            // Check again if user queued messages during auto-allowed tool execution
            if (waitingForQueueCancelRef.current) {
              if (restoreQueueOnCancelRef.current) {
                // User hit ESC during queue cancel - abort the auto-send
                setRestoreQueueOnCancel(false);
              } else {
                // Create denial results for tools that need user input
                const denialResults = needsUserInput.map((ac) => ({
                  type: "approval" as const,
                  tool_call_id: ac.approval.toolCallId,
                  approve: false,
                  reason: "User cancelled - new message queued",
                }));

                // Update buffers to show tools as cancelled
                for (const ac of needsUserInput) {
                  onChunk(buffersRef.current, {
                    message_type: "tool_return_message",
                    id: "dummy",
                    date: new Date().toISOString(),
                    tool_call_id: ac.approval.toolCallId,
                    tool_return: "Cancelled - user sent new message",
                    status: "error",
                  });
                }
                refreshDerived();

                // Combine with auto-handled results and queue for sending
                const allResults = [
                  ...autoAllowedResults.map((ar) => ({
                    type: "tool" as const,
                    tool_call_id: ar.toolCallId,
                    tool_return: ar.result.toolReturn,
                    status: ar.result.status,
                  })),
                  ...autoDeniedResults.map((ad) => ({
                    type: "approval" as const,
                    tool_call_id: ad.approval.toolCallId,
                    approve: false,
                    reason: ad.reason,
                  })),
                  ...denialResults,
                ];
                setQueuedApprovalResults(allResults);

                // Get queued messages and clear queue
                const concatenatedMessage = queueSnapshotRef.current.join("\n");
                setMessageQueue([]);

                // Send via onSubmit
                if (concatenatedMessage.trim()) {
                  onSubmitRef.current(concatenatedMessage);
                }
              }

              // Reset flags
              waitingForQueueCancelRef.current = false;
              queueSnapshotRef.current = [];
              setStreaming(false);
              return;
            }

            // Show approval dialog for tools that need user input
            setPendingApprovals(needsUserInput.map((ac) => ac.approval));
            setApprovalContexts(
              needsUserInput
                .map((ac) => ac.context)
                .filter((ctx): ctx is ApprovalContext => ctx !== null),
            );
            setAutoHandledResults(autoAllowedResults);
            setAutoDeniedApprovals(autoDeniedResults);
            setStreaming(false);
            return;
          }

          // Unexpected stop reason (error, llm_api_error, etc.)
          // Mark incomplete tool calls as finished to prevent stuck blinking UI
          markIncompleteToolsAsCancelled(buffersRef.current);

          // Fetch error details from the run if available
          if (lastRunId) {
            try {
              const client = await getClient();
              const run = await client.runs.retrieve(lastRunId);

              // Check if run has error information in metadata
              if (run.metadata?.error) {
                const errorData = run.metadata.error as {
                  type?: string;
                  message?: string;
                  detail?: string;
                };

                // Pass structured error data to our formatter
                const errorObject = {
                  error: {
                    error: errorData,
                    run_id: lastRunId,
                  },
                };
                const errorDetails = formatErrorDetails(
                  errorObject,
                  agentIdRef.current,
                );
                appendError(errorDetails);
              } else {
                // No error metadata, show generic error with run info
                appendError(
                  `An error occurred during agent execution\n(run_id: ${lastRunId}, stop_reason: ${stopReason})`,
                );
              }
            } catch (_e) {
              // If we can't fetch error details, show generic error
              appendError(
                `An error occurred during agent execution\n(run_id: ${lastRunId}, stop_reason: ${stopReason})\n(Unable to fetch additional error details from server)`,
              );
              return;
            }
          } else {
            // No run_id available - but this is unusual since errors should have run_ids
            appendError(
              `An error occurred during agent execution\n(stop_reason: ${stopReason})`,
            );
          }

          setStreaming(false);
          refreshDerived();
          return;
        }
      } catch (e) {
        // Mark incomplete tool calls as cancelled to prevent stuck blinking UI
        markIncompleteToolsAsCancelled(buffersRef.current);

        // If using eager cancel and this is an abort error, silently ignore it
        // The user already got "Stream interrupted by user" feedback from handleInterrupt
        if (EAGER_CANCEL && e instanceof APIUserAbortError) {
          setStreaming(false);
          refreshDerived();
          return;
        }

        // Use comprehensive error formatting
        const errorDetails = formatErrorDetails(e, agentIdRef.current);
        appendError(errorDetails);
        setStreaming(false);
        refreshDerived();
      } finally {
        abortControllerRef.current = null;
      }
    },
    [appendError, refreshDerived, refreshDerivedThrottled],
  );

  const handleExit = useCallback(() => {
    setShowExitStats(true);
    // Give React time to render the stats, then exit
    setTimeout(() => {
      process.exit(0);
    }, 100);
  }, []);

  // Handler when user presses UP/ESC to load queue into input for editing
  const handleEnterQueueEditMode = useCallback(() => {
    setMessageQueue([]);
  }, []);

  const handleInterrupt = useCallback(async () => {
    // If we're executing client-side tools, abort them locally instead of hitting the backend
    if (isExecutingTool && toolAbortControllerRef.current) {
      toolAbortControllerRef.current.abort();
      setStreaming(false);
      setIsExecutingTool(false);
      appendError("Stream interrupted by user");
      refreshDerived();
      return;
    }

    if (!streaming || interruptRequested) return;

    // If we're in the middle of queue cancel, set flag to restore instead of auto-send
    if (waitingForQueueCancelRef.current) {
      setRestoreQueueOnCancel(true);
      // Don't reset flags - let the cancel complete naturally
    }

    // If EAGER_CANCEL is enabled, immediately stop everything client-side first
    if (EAGER_CANCEL) {
      // Abort the stream via abort signal
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }

      // Set cancellation flag to prevent processConversation from starting
      userCancelledRef.current = true;

      // Stop streaming and show error message
      setStreaming(false);
      markIncompleteToolsAsCancelled(buffersRef.current);
      appendError("Stream interrupted by user");
      refreshDerived();

      // Clear any pending approvals since we're cancelling
      setPendingApprovals([]);
      setApprovalContexts([]);
      setApprovalResults([]);
      setAutoHandledResults([]);
      setAutoDeniedApprovals([]);

      // Send cancel request to backend asynchronously (fire-and-forget)
      // Don't wait for it or show errors since user already got feedback
      getClient()
        .then((client) => client.agents.messages.cancel(agentId))
        .catch(() => {
          // Silently ignore - cancellation already happened client-side
        });

      return;
    } else {
      setInterruptRequested(true);
      try {
        const client = await getClient();
        await client.agents.messages.cancel(agentId);

        if (abortControllerRef.current) {
          abortControllerRef.current.abort();
        }
      } catch (e) {
        const errorDetails = formatErrorDetails(e, agentId);
        appendError(`Failed to interrupt stream: ${errorDetails}`);
        setInterruptRequested(false);
      }
    }
  }, [
    agentId,
    streaming,
    interruptRequested,
    appendError,
    isExecutingTool,
    refreshDerived,
  ]);

  // Keep ref to latest processConversation to avoid circular deps in useEffect
  const processConversationRef = useRef(processConversation);
  useEffect(() => {
    processConversationRef.current = processConversation;
  }, [processConversation]);

  // Reset interrupt flag when streaming ends
  useEffect(() => {
    if (!streaming) {
      setInterruptRequested(false);
    }
  }, [streaming]);

  const handleAgentSelect = useCallback(
    async (targetAgentId: string, _opts?: { profileName?: string }) => {
      setAgentSelectorOpen(false);

      // Skip if already on this agent
      if (targetAgentId === agentId) {
        const label = agentName || targetAgentId.slice(0, 12);
        const cmdId = uid("cmd");
        buffersRef.current.byId.set(cmdId, {
          kind: "command",
          id: cmdId,
          input: "/pinned",
          output: `Already on "${label}"`,
          phase: "finished",
          success: true,
        });
        buffersRef.current.order.push(cmdId);
        refreshDerived();
        return;
      }

      const inputCmd = "/pinned";

      setCommandRunning(true);

      try {
        const client = await getClient();
        // Fetch new agent
        const agent = await client.agents.retrieve(targetAgentId);

        // Fetch agent's message history
        const messagesPage = await client.agents.messages.list(targetAgentId);
        const messages = messagesPage.items;

        // Update project settings with new agent
        await updateProjectSettings({ lastAgent: targetAgentId });

        // Clear current transcript and static items
        buffersRef.current.byId.clear();
        buffersRef.current.order = [];
        buffersRef.current.tokenCount = 0;
        emittedIdsRef.current.clear();
        setStaticItems([]);
        setStaticRenderEpoch((e) => e + 1);

        // Update agent state - also update ref immediately for any code that runs before re-render
        agentIdRef.current = targetAgentId;
        setAgentId(targetAgentId);
        setAgentState(agent);
        setAgentName(agent.name);
        setLlmConfig(agent.llm_config);

        // Build success command
        const agentUrl = `https://app.letta.com/projects/default-project/agents/${targetAgentId}`;
        const successOutput = `Resumed "${agent.name || targetAgentId}"\n⎿  ${agentUrl}`;
        const successItem: StaticItem = {
          kind: "command",
          id: uid("cmd"),
          input: inputCmd,
          output: successOutput,
          phase: "finished",
          success: true,
        };

        // Backfill message history with visual separator, then success command at end
        if (messages.length > 0) {
          hasBackfilledRef.current = false;
          backfillBuffers(buffersRef.current, messages);
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
          setStaticItems([separator, ...backfilledItems, successItem]);
          setLines(toLines(buffersRef.current));
          hasBackfilledRef.current = true;
        } else {
          setStaticItems([successItem]);
        }
      } catch (error) {
        const errorDetails = formatErrorDetails(error, agentId);
        const errorCmdId = uid("cmd");
        buffersRef.current.byId.set(errorCmdId, {
          kind: "command",
          id: errorCmdId,
          input: inputCmd,
          output: `Failed: ${errorDetails}`,
          phase: "finished",
          success: false,
        });
        buffersRef.current.order.push(errorCmdId);
        refreshDerived();
      } finally {
        setCommandRunning(false);
      }
    },
    [refreshDerived, agentId, agentName],
  );

  const onSubmit = useCallback(
    async (message?: string): Promise<{ submitted: boolean }> => {
      const msg = message?.trim() ?? "";

      // Handle profile load confirmation (Enter to continue)
      if (profileConfirmPending && !msg) {
        // User pressed Enter with empty input - proceed with loading
        const { name, agentId: targetAgentId, cmdId } = profileConfirmPending;
        buffersRef.current.byId.delete(cmdId);
        const orderIdx = buffersRef.current.order.indexOf(cmdId);
        if (orderIdx !== -1) buffersRef.current.order.splice(orderIdx, 1);
        refreshDerived();
        setProfileConfirmPending(null);
        await handleAgentSelect(targetAgentId, { profileName: name });
        return { submitted: true };
      }

      // Cancel profile confirmation if user types something else
      if (profileConfirmPending && msg) {
        const { cmdId } = profileConfirmPending;
        buffersRef.current.byId.set(cmdId, {
          kind: "command",
          id: cmdId,
          input: `/profile load ${profileConfirmPending.name}`,
          output: "Cancelled",
          phase: "finished",
          success: false,
        });
        refreshDerived();
        setProfileConfirmPending(null);
        // Continue processing the new message
      }

      if (!msg) return { submitted: false };

      // Block submission if waiting for explicit user action (approvals)
      // In this case, input is hidden anyway, so this shouldn't happen
      if (pendingApprovals.length > 0) {
        return { submitted: false };
      }

      // Queue message if agent is busy (streaming, executing tool, or running command)
      // This allows messages to queue up while agent is working
      const agentBusy = streaming || isExecutingTool || commandRunning;

      if (agentBusy) {
        setMessageQueue((prev) => {
          const newQueue = [...prev, msg];

          // Always update snapshot to include ALL queued messages
          queueSnapshotRef.current = [...newQueue];

          // If this is the first queued message, send cancel request
          if (!waitingForQueueCancelRef.current) {
            waitingForQueueCancelRef.current = true;

            // Send cancel request to backend (fire-and-forget)
            getClient()
              .then((client) => client.agents.messages.cancel(agentId))
              .then(() => {})
              .catch(() => {
                // Reset flag if cancel fails
                waitingForQueueCancelRef.current = false;
              });
          }

          return newQueue;
        });
        return { submitted: true }; // Clears input
      }

      // Reset cancellation flag when starting new submission
      // This ensures that after an interrupt, new messages can be sent
      userCancelledRef.current = false;

      let aliasedMsg = msg;
      if (msg === "exit" || msg === "quit") {
        aliasedMsg = "/exit";
      }

      // Handle commands (messages starting with "/")
      if (aliasedMsg.startsWith("/")) {
        const trimmed = aliasedMsg.trim();

        // Special handling for /model command - opens selector
        if (trimmed === "/model") {
          setModelSelectorOpen(true);
          return { submitted: true };
        }

        // Special handling for /toolset command - opens selector
        if (trimmed === "/toolset") {
          setToolsetSelectorOpen(true);
          return { submitted: true };
        }

        // Special handling for /system command - opens system prompt selector
        if (trimmed === "/system") {
          setSystemPromptSelectorOpen(true);
          return { submitted: true };
        }

        // Special handling for /subagents command - opens subagent manager
        if (trimmed === "/subagents") {
          setSubagentManagerOpen(true);
          return { submitted: true };
        }

        // Special handling for /exit command - show stats and exit
        if (trimmed === "/exit") {
          handleExit();
          return { submitted: true };
        }

        // Special handling for /logout command - clear credentials and exit
        if (trimmed === "/logout") {
          const cmdId = uid("cmd");
          buffersRef.current.byId.set(cmdId, {
            kind: "command",
            id: cmdId,
            input: msg,
            output: "Logging out...",
            phase: "running",
          });
          buffersRef.current.order.push(cmdId);
          refreshDerived();

          setCommandRunning(true);

          try {
            const { settingsManager } = await import("../settings-manager");
            const currentSettings = settingsManager.getSettings();

            // Revoke refresh token on server if we have one
            if (currentSettings.refreshToken) {
              const { revokeToken } = await import("../auth/oauth");
              await revokeToken(currentSettings.refreshToken);
            }

            // Clear local credentials
            const newEnv = { ...currentSettings.env };
            delete newEnv.LETTA_API_KEY;
            // Note: LETTA_BASE_URL is intentionally NOT deleted from settings
            // because it should not be stored there in the first place

            settingsManager.updateSettings({
              env: newEnv,
              refreshToken: undefined,
              tokenExpiresAt: undefined,
            });

            buffersRef.current.byId.set(cmdId, {
              kind: "command",
              id: cmdId,
              input: msg,
              output:
                "✓ Logged out successfully. Run 'letta' to re-authenticate.",
              phase: "finished",
              success: true,
            });
            refreshDerived();

            // Exit after a brief delay to show the message
            setTimeout(() => process.exit(0), 500);
          } catch (error) {
            const errorDetails = formatErrorDetails(error, agentId);
            buffersRef.current.byId.set(cmdId, {
              kind: "command",
              id: cmdId,
              input: msg,
              output: `Failed: ${errorDetails}`,
              phase: "finished",
              success: false,
            });
            refreshDerived();
          } finally {
            setCommandRunning(false);
          }
          return { submitted: true };
        }

        // Special handling for /stream command - toggle and save
        if (msg.trim() === "/stream") {
          const newValue = !tokenStreamingEnabled;

          // Immediately add command to transcript with "running" phase and loading message
          const cmdId = uid("cmd");
          buffersRef.current.byId.set(cmdId, {
            kind: "command",
            id: cmdId,
            input: msg,
            output: `${newValue ? "Enabling" : "Disabling"} token streaming...`,
            phase: "running",
          });
          buffersRef.current.order.push(cmdId);
          refreshDerived();

          // Lock input during async operation
          setCommandRunning(true);

          try {
            setTokenStreamingEnabled(newValue);

            // Save to settings
            const { settingsManager } = await import("../settings-manager");
            settingsManager.updateSettings({ tokenStreaming: newValue });

            // Update the same command with final result
            buffersRef.current.byId.set(cmdId, {
              kind: "command",
              id: cmdId,
              input: msg,
              output: `Token streaming ${newValue ? "enabled" : "disabled"}`,
              phase: "finished",
              success: true,
            });
            refreshDerived();
          } catch (error) {
            // Mark command as failed
            const errorDetails = formatErrorDetails(error, agentId);
            buffersRef.current.byId.set(cmdId, {
              kind: "command",
              id: cmdId,
              input: msg,
              output: `Failed: ${errorDetails}`,
              phase: "finished",
              success: false,
            });
            refreshDerived();
          } finally {
            // Unlock input
            setCommandRunning(false);
          }
          return { submitted: true };
        }

        // Special handling for /clear command - reset conversation
        if (msg.trim() === "/clear") {
          const cmdId = uid("cmd");
          buffersRef.current.byId.set(cmdId, {
            kind: "command",
            id: cmdId,
            input: msg,
            output: "Clearing conversation...",
            phase: "running",
          });
          buffersRef.current.order.push(cmdId);
          refreshDerived();

          setCommandRunning(true);

          try {
            const client = await getClient();
            await client.agents.messages.reset(agentId, {
              add_default_initial_messages: false,
            });

            // Clear local buffers and static items
            // buffersRef.current.byId.clear();
            // buffersRef.current.order = [];
            // buffersRef.current.tokenCount = 0;
            // emittedIdsRef.current.clear();
            // setStaticItems([]);

            // Update command with success
            buffersRef.current.byId.set(cmdId, {
              kind: "command",
              id: cmdId,
              input: msg,
              output: "Conversation cleared",
              phase: "finished",
              success: true,
            });
            buffersRef.current.order.push(cmdId);
            refreshDerived();
          } catch (error) {
            const errorDetails = formatErrorDetails(error, agentId);
            buffersRef.current.byId.set(cmdId, {
              kind: "command",
              id: cmdId,
              input: msg,
              output: `Failed: ${errorDetails}`,
              phase: "finished",
              success: false,
            });
            refreshDerived();
          } finally {
            setCommandRunning(false);
          }
          return { submitted: true };
        }

        // Special handling for /link command - attach Letta Code tools
        if (msg.trim() === "/link") {
          const cmdId = uid("cmd");
          buffersRef.current.byId.set(cmdId, {
            kind: "command",
            id: cmdId,
            input: msg,
            output: "Attaching Letta Code tools to agent...",
            phase: "running",
          });
          buffersRef.current.order.push(cmdId);
          refreshDerived();

          setCommandRunning(true);

          try {
            const result = await linkToolsToAgent(agentId);

            buffersRef.current.byId.set(cmdId, {
              kind: "command",
              id: cmdId,
              input: msg,
              output: result.message,
              phase: "finished",
              success: result.success,
            });
            refreshDerived();
          } catch (error) {
            const errorDetails = formatErrorDetails(error, agentId);
            buffersRef.current.byId.set(cmdId, {
              kind: "command",
              id: cmdId,
              input: msg,
              output: `Failed: ${errorDetails}`,
              phase: "finished",
              success: false,
            });
            refreshDerived();
          } finally {
            setCommandRunning(false);
          }
          return { submitted: true };
        }

        // Special handling for /unlink command - remove Letta Code tools
        if (msg.trim() === "/unlink") {
          const cmdId = uid("cmd");
          buffersRef.current.byId.set(cmdId, {
            kind: "command",
            id: cmdId,
            input: msg,
            output: "Removing Letta Code tools from agent...",
            phase: "running",
          });
          buffersRef.current.order.push(cmdId);
          refreshDerived();

          setCommandRunning(true);

          try {
            const result = await unlinkToolsFromAgent(agentId);

            buffersRef.current.byId.set(cmdId, {
              kind: "command",
              id: cmdId,
              input: msg,
              output: result.message,
              phase: "finished",
              success: result.success,
            });
            refreshDerived();
          } catch (error) {
            const errorDetails = formatErrorDetails(error, agentId);
            buffersRef.current.byId.set(cmdId, {
              kind: "command",
              id: cmdId,
              input: msg,
              output: `Failed: ${errorDetails}`,
              phase: "finished",
              success: false,
            });
            refreshDerived();
          } finally {
            setCommandRunning(false);
          }
          return { submitted: true };
        }

        // Special handling for /rename command - rename the agent
        if (msg.trim().startsWith("/rename")) {
          const parts = msg.trim().split(/\s+/);
          const newName = parts.slice(1).join(" ");

          if (!newName) {
            const cmdId = uid("cmd");
            buffersRef.current.byId.set(cmdId, {
              kind: "command",
              id: cmdId,
              input: msg,
              output: "Please provide a new name: /rename <name>",
              phase: "finished",
              success: false,
            });
            buffersRef.current.order.push(cmdId);
            refreshDerived();
            return { submitted: true };
          }

          const cmdId = uid("cmd");
          buffersRef.current.byId.set(cmdId, {
            kind: "command",
            id: cmdId,
            input: msg,
            output: `Renaming agent to "${newName}"...`,
            phase: "running",
          });
          buffersRef.current.order.push(cmdId);
          refreshDerived();

          setCommandRunning(true);

          try {
            const client = await getClient();
            await client.agents.update(agentId, { name: newName });
            setAgentName(newName);

            buffersRef.current.byId.set(cmdId, {
              kind: "command",
              id: cmdId,
              input: msg,
              output: `Agent renamed to "${newName}"`,
              phase: "finished",
              success: true,
            });
            refreshDerived();
          } catch (error) {
            const errorDetails = formatErrorDetails(error, agentId);
            buffersRef.current.byId.set(cmdId, {
              kind: "command",
              id: cmdId,
              input: msg,
              output: `Failed: ${errorDetails}`,
              phase: "finished",
              success: false,
            });
            refreshDerived();
          } finally {
            setCommandRunning(false);
          }
          return { submitted: true };
        }

        // Special handling for /description command - update agent description
        if (msg.trim().startsWith("/description")) {
          const parts = msg.trim().split(/\s+/);
          const newDescription = parts.slice(1).join(" ");

          if (!newDescription) {
            const cmdId = uid("cmd");
            buffersRef.current.byId.set(cmdId, {
              kind: "command",
              id: cmdId,
              input: msg,
              output: "Please provide a description: /description <text>",
              phase: "finished",
              success: false,
            });
            buffersRef.current.order.push(cmdId);
            refreshDerived();
            return { submitted: true };
          }

          const cmdId = uid("cmd");
          buffersRef.current.byId.set(cmdId, {
            kind: "command",
            id: cmdId,
            input: msg,
            output: "Updating description...",
            phase: "running",
          });
          buffersRef.current.order.push(cmdId);
          refreshDerived();

          setCommandRunning(true);

          try {
            const client = await getClient();
            await client.agents.update(agentId, {
              description: newDescription,
            });

            buffersRef.current.byId.set(cmdId, {
              kind: "command",
              id: cmdId,
              input: msg,
              output: `Description updated to "${newDescription}"`,
              phase: "finished",
              success: true,
            });
            refreshDerived();
          } catch (error) {
            const errorDetails = formatErrorDetails(error, agentId);
            buffersRef.current.byId.set(cmdId, {
              kind: "command",
              id: cmdId,
              input: msg,
              output: `Failed: ${errorDetails}`,
              phase: "finished",
              success: false,
            });
            refreshDerived();
          } finally {
            setCommandRunning(false);
          }
          return { submitted: true };
        }

        // Special handling for /resume command - show session resume selector
        if (msg.trim() === "/agents" || msg.trim() === "/resume") {
          setResumeSelectorOpen(true);
          return { submitted: true };
        }

        // Special handling for /search command - show message search
        if (msg.trim() === "/search") {
          setMessageSearchOpen(true);
          return { submitted: true };
        }

        // Special handling for /profile command - manage local profiles
        if (msg.trim().startsWith("/profile")) {
          const parts = msg.trim().split(/\s+/);
          const subcommand = parts[1]?.toLowerCase();
          const profileName = parts.slice(2).join(" ");

          const profileCtx: ProfileCommandContext = {
            buffersRef,
            refreshDerived,
            agentId,
            agentName: agentName || "",
            setCommandRunning,
            setAgentName,
          };

          // /profile - open profile selector
          if (!subcommand) {
            setProfileSelectorOpen(true);
            return { submitted: true };
          }

          // /profile save <name>
          if (subcommand === "save") {
            await handleProfileSave(profileCtx, msg, profileName);
            return { submitted: true };
          }

          // /profile load <name>
          if (subcommand === "load") {
            const validation = validateProfileLoad(
              profileCtx,
              msg,
              profileName,
            );
            if (validation.errorMessage) {
              return { submitted: true };
            }

            if (validation.needsConfirmation && validation.targetAgentId) {
              // Show warning and wait for confirmation
              const cmdId = addCommandResult(
                buffersRef,
                refreshDerived,
                msg,
                "Warning: Current agent is not saved to any profile.\nPress Enter to continue, or type anything to cancel.",
                false,
                "running",
              );
              setProfileConfirmPending({
                name: profileName,
                agentId: validation.targetAgentId,
                cmdId,
              });
              return { submitted: true };
            }

            // Current agent is saved, proceed with loading
            if (validation.targetAgentId) {
              await handleAgentSelect(validation.targetAgentId, {
                profileName,
              });
            }
            return { submitted: true };
          }

          // /profile delete <name>
          if (subcommand === "delete") {
            handleProfileDelete(profileCtx, msg, profileName);
            return { submitted: true };
          }

          // Unknown subcommand
          handleProfileUsage(profileCtx, msg);
          return { submitted: true };
        }

        // Special handling for /profiles and /pinned commands - open pinned agents selector
        if (msg.trim() === "/profiles" || msg.trim() === "/pinned") {
          setProfileSelectorOpen(true);
          return { submitted: true };
        }

        // Special handling for /pin command - pin current agent to project (or globally with -g)
        if (msg.trim() === "/pin" || msg.trim().startsWith("/pin ")) {
          const profileCtx: ProfileCommandContext = {
            buffersRef,
            refreshDerived,
            agentId,
            agentName: agentName || "",
            setCommandRunning,
            setAgentName,
          };
          const argsStr = msg.trim().slice(4).trim();
          await handlePin(profileCtx, msg, argsStr);
          return { submitted: true };
        }

        // Special handling for /unpin command - unpin current agent from project (or globally with -g)
        if (msg.trim() === "/unpin" || msg.trim().startsWith("/unpin ")) {
          const profileCtx: ProfileCommandContext = {
            buffersRef,
            refreshDerived,
            agentId,
            agentName: agentName || "",
            setCommandRunning,
            setAgentName,
          };
          const argsStr = msg.trim().slice(6).trim();
          handleUnpin(profileCtx, msg, argsStr);
          return { submitted: true };
        }

        // Special handling for /bg command - show background shell processes
        if (msg.trim() === "/bg") {
          const { backgroundProcesses } = await import(
            "../tools/impl/process_manager"
          );
          const cmdId = uid("cmd");

          let output: string;
          if (backgroundProcesses.size === 0) {
            output = "No background processes running";
          } else {
            const lines = ["Background processes:"];
            for (const [id, proc] of backgroundProcesses) {
              const status =
                proc.status === "running"
                  ? "running"
                  : proc.status === "completed"
                    ? `completed (exit ${proc.exitCode})`
                    : `failed (exit ${proc.exitCode})`;
              lines.push(`  ${id}: ${proc.command} [${status}]`);
            }
            output = lines.join("\n");
          }

          buffersRef.current.byId.set(cmdId, {
            kind: "command",
            id: cmdId,
            input: msg,
            output,
            phase: "finished",
            success: true,
          });
          buffersRef.current.order.push(cmdId);
          refreshDerived();
          return { submitted: true };
        }

        // Special handling for /download command - download agent file
        if (msg.trim() === "/download") {
          const cmdId = uid("cmd");
          buffersRef.current.byId.set(cmdId, {
            kind: "command",
            id: cmdId,
            input: msg,
            output: "Downloading agent file...",
            phase: "running",
          });
          buffersRef.current.order.push(cmdId);
          refreshDerived();

          setCommandRunning(true);

          try {
            const client = await getClient();
            const fileContent = await client.agents.exportFile(agentId);
            const fileName = `${agentId}.af`;
            writeFileSync(fileName, JSON.stringify(fileContent, null, 2));

            buffersRef.current.byId.set(cmdId, {
              kind: "command",
              id: cmdId,
              input: msg,
              output: `AgentFile downloaded to ${fileName}`,
              phase: "finished",
              success: true,
            });
            refreshDerived();
          } catch (error) {
            const errorDetails = formatErrorDetails(error, agentId);
            buffersRef.current.byId.set(cmdId, {
              kind: "command",
              id: cmdId,
              input: msg,
              output: `Failed: ${errorDetails}`,
              phase: "finished",
              success: false,
            });
            refreshDerived();
          } finally {
            setCommandRunning(false);
          }
          return { submitted: true };
        }

        // Special handling for /skill command - enter skill creation mode
        if (trimmed.startsWith("/skill")) {
          const cmdId = uid("cmd");

          // Extract optional description after `/skill`
          const [, ...rest] = trimmed.split(/\s+/);
          const description = rest.join(" ").trim();

          const initialOutput = description
            ? `Starting skill creation for: ${description}`
            : "Starting skill creation. I’ll load the skill-creator skill and ask a few questions about the skill you want to build...";

          buffersRef.current.byId.set(cmdId, {
            kind: "command",
            id: cmdId,
            input: msg,
            output: initialOutput,
            phase: "running",
          });
          buffersRef.current.order.push(cmdId);
          refreshDerived();

          setCommandRunning(true);

          try {
            // Import the skill-creation prompt
            const { SKILL_CREATOR_PROMPT } = await import(
              "../agent/promptAssets.js"
            );

            // Build system-reminder content for skill creation
            const userDescriptionLine = description
              ? `\n\nUser-provided skill description:\n${description}`
              : "\n\nThe user did not provide a description with /skill. Ask what kind of skill they want to create before proceeding.";

            const skillMessage = `<system-reminder>\n${SKILL_CREATOR_PROMPT}${userDescriptionLine}\n</system-reminder>`;

            // Mark command as finished before sending message
            buffersRef.current.byId.set(cmdId, {
              kind: "command",
              id: cmdId,
              input: msg,
              output:
                "Entered skill creation mode. Answer the assistant’s questions to design your new skill.",
              phase: "finished",
              success: true,
            });
            refreshDerived();

            // Process conversation with the skill-creation prompt
            await processConversation([
              {
                type: "message",
                role: "user",
                content: skillMessage,
              },
            ]);
          } catch (error) {
            const errorDetails = formatErrorDetails(error, agentId);
            buffersRef.current.byId.set(cmdId, {
              kind: "command",
              id: cmdId,
              input: msg,
              output: `Failed: ${errorDetails}`,
              phase: "finished",
              success: false,
            });
            refreshDerived();
          } finally {
            setCommandRunning(false);
          }

          return { submitted: true };
        }

        // Special handling for /remember command - remember something from conversation
        if (trimmed.startsWith("/remember")) {
          const cmdId = uid("cmd");

          // Extract optional description after `/remember`
          const [, ...rest] = trimmed.split(/\s+/);
          const userText = rest.join(" ").trim();

          const initialOutput = userText
            ? "Storing to memory..."
            : "Processing memory request...";

          buffersRef.current.byId.set(cmdId, {
            kind: "command",
            id: cmdId,
            input: msg,
            output: initialOutput,
            phase: "running",
          });
          buffersRef.current.order.push(cmdId);
          refreshDerived();

          setCommandRunning(true);

          try {
            // Import the remember prompt
            const { REMEMBER_PROMPT } = await import(
              "../agent/promptAssets.js"
            );

            // Build system-reminder content for memory request
            const rememberMessage = userText
              ? `<system-reminder>\n${REMEMBER_PROMPT}\n</system-reminder>${userText}`
              : `<system-reminder>\n${REMEMBER_PROMPT}\n\nThe user did not specify what to remember. Look at the recent conversation context to identify what they likely want you to remember, or ask them to clarify.\n</system-reminder>`;

            // Mark command as finished before sending message
            buffersRef.current.byId.set(cmdId, {
              kind: "command",
              id: cmdId,
              input: msg,
              output: userText
                ? "Storing to memory..."
                : "Processing memory request from conversation context...",
              phase: "finished",
              success: true,
            });
            refreshDerived();

            // Process conversation with the remember prompt
            await processConversation([
              {
                type: "message",
                role: "user",
                content: rememberMessage,
              },
            ]);
          } catch (error) {
            const errorDetails = formatErrorDetails(error, agentId);
            buffersRef.current.byId.set(cmdId, {
              kind: "command",
              id: cmdId,
              input: msg,
              output: `Failed: ${errorDetails}`,
              phase: "finished",
              success: false,
            });
            refreshDerived();
          } finally {
            setCommandRunning(false);
          }

          return { submitted: true };
        }

        // Special handling for /init command - initialize agent memory
        if (trimmed === "/init") {
          const cmdId = uid("cmd");
          buffersRef.current.byId.set(cmdId, {
            kind: "command",
            id: cmdId,
            input: msg,
            output: "Gathering project context...",
            phase: "running",
          });
          buffersRef.current.order.push(cmdId);
          refreshDerived();

          setCommandRunning(true);

          try {
            // Import the initialization prompt
            const { INITIALIZE_PROMPT } = await import(
              "../agent/promptAssets.js"
            );

            // Gather git context if available
            let gitContext = "";
            try {
              const { execSync } = await import("node:child_process");
              const cwd = process.cwd();

              // Check if we're in a git repo
              try {
                execSync("git rev-parse --git-dir", {
                  cwd,
                  stdio: "pipe",
                });

                // Gather git info
                const branch = execSync("git branch --show-current", {
                  cwd,
                  encoding: "utf-8",
                }).trim();
                const mainBranch = execSync(
                  "git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@' || echo 'main'",
                  { cwd, encoding: "utf-8", shell: "/bin/bash" },
                ).trim();
                const status = execSync("git status --short", {
                  cwd,
                  encoding: "utf-8",
                }).trim();
                const recentCommits = execSync(
                  "git log --oneline -10 2>/dev/null || echo 'No commits yet'",
                  { cwd, encoding: "utf-8" },
                ).trim();

                gitContext = `
## Current Project Context

**Working directory**: ${cwd}

### Git Status
- **Current branch**: ${branch}
- **Main branch**: ${mainBranch}
- **Status**:
${status || "(clean working tree)"}

### Recent Commits
${recentCommits}
`;
              } catch {
                // Not a git repo, just include working directory
                gitContext = `
## Current Project Context

**Working directory**: ${cwd}
**Git**: Not a git repository
`;
              }
            } catch {
              // execSync import failed, skip git context
            }

            // Mark command as finished before sending message
            buffersRef.current.byId.set(cmdId, {
              kind: "command",
              id: cmdId,
              input: msg,
              output:
                "Assimilating project context and defragmenting memories...",
              phase: "finished",
              success: true,
            });
            refreshDerived();

            // Send initialization prompt with git context as a system reminder
            const initMessage = `<system-reminder>\n${INITIALIZE_PROMPT}\n${gitContext}\n</system-reminder>`;

            // Process conversation with the init prompt
            await processConversation([
              {
                type: "message",
                role: "user",
                content: initMessage,
              },
            ]);
          } catch (error) {
            const errorDetails = formatErrorDetails(error, agentId);
            buffersRef.current.byId.set(cmdId, {
              kind: "command",
              id: cmdId,
              input: msg,
              output: `Failed: ${errorDetails}`,
              phase: "finished",
              success: false,
            });
            refreshDerived();
          } finally {
            setCommandRunning(false);
          }
          return { submitted: true };
        }

        // Immediately add command to transcript with "running" phase
        const cmdId = uid("cmd");
        buffersRef.current.byId.set(cmdId, {
          kind: "command",
          id: cmdId,
          input: msg,
          output: "",
          phase: "running",
        });
        buffersRef.current.order.push(cmdId);
        refreshDerived();

        // Lock input during async operation
        setCommandRunning(true);

        try {
          const { executeCommand } = await import("./commands/registry");
          const result = await executeCommand(msg);

          // Update the same command with result
          buffersRef.current.byId.set(cmdId, {
            kind: "command",
            id: cmdId,
            input: msg,
            output: result.output,
            phase: "finished",
            success: result.success,
          });
          refreshDerived();
        } catch (error) {
          // Mark command as failed if executeCommand throws
          const errorDetails = formatErrorDetails(error, agentId);
          buffersRef.current.byId.set(cmdId, {
            kind: "command",
            id: cmdId,
            input: msg,
            output: `Failed: ${errorDetails}`,
            phase: "finished",
            success: false,
          });
          refreshDerived();
        } finally {
          // Unlock input
          setCommandRunning(false);
        }
        return { submitted: true }; // Don't send commands to Letta agent
      }

      // Build message content from display value (handles placeholders for text/images)
      const contentParts = buildMessageContentFromDisplay(msg);

      // Prepend plan mode reminder if in plan mode
      const planModeReminder = getPlanModeReminder();

      // Prepend skill unload reminder if skills are loaded (using cached flag)
      const skillUnloadReminder = getSkillUnloadReminder();

      // Prepend session context on first message of CLI session (if enabled)
      let sessionContextReminder = "";
      const sessionContextEnabled = settingsManager.getSetting(
        "sessionContextEnabled",
      );
      if (!hasSentSessionContextRef.current && sessionContextEnabled) {
        const { buildSessionContext } = await import(
          "./helpers/sessionContext"
        );
        sessionContextReminder = buildSessionContext({
          agentInfo: {
            id: agentId,
            name: agentName,
            description: agentDescription,
            lastRunAt: agentLastRunAt,
          },
        });
        hasSentSessionContextRef.current = true;
      }

      // Combine reminders with content (session context first, then plan mode, then skill unload)
      const allReminders =
        sessionContextReminder + planModeReminder + skillUnloadReminder;
      const messageContent =
        allReminders && typeof contentParts === "string"
          ? allReminders + contentParts
          : Array.isArray(contentParts) && allReminders
            ? [{ type: "text" as const, text: allReminders }, ...contentParts]
            : contentParts;

      // Append the user message to transcript IMMEDIATELY (optimistic update)
      const userId = uid("user");
      buffersRef.current.byId.set(userId, {
        kind: "user",
        id: userId,
        text: msg,
      });
      buffersRef.current.order.push(userId);

      // Reset token counter for this turn (only count the agent's response)
      buffersRef.current.tokenCount = 0;
      // Rotate to a new thinking message for this turn
      setThinkingMessage(getRandomThinkingMessage());
      // Show streaming state immediately for responsiveness
      setStreaming(true);
      refreshDerived();

      // Check for pending approvals before sending message (skip if we already have
      // a queued approval response to send first).
      if (CHECK_PENDING_APPROVALS_BEFORE_SEND && !queuedApprovalResults) {
        try {
          const client = await getClient();
          // Fetch fresh agent state to check for pending approvals with accurate in-context messages
          const agent = await client.agents.retrieve(agentId);
          const { pendingApprovals: existingApprovals } = await getResumeData(
            client,
            agent,
          );

          // Check if user cancelled while we were fetching approval state
          if (
            userCancelledRef.current ||
            abortControllerRef.current?.signal.aborted
          ) {
            // User hit ESC during the check - abort and clean up
            buffersRef.current.byId.delete(userId);
            const orderIndex = buffersRef.current.order.indexOf(userId);
            if (orderIndex !== -1) {
              buffersRef.current.order.splice(orderIndex, 1);
            }
            setStreaming(false);
            refreshDerived();
            return { submitted: false };
          }

          if (existingApprovals && existingApprovals.length > 0) {
            // There are pending approvals - show them and DON'T send the message yet
            // The message will be restored to the input field for the user to decide

            // Remove the optimistic user message from transcript to avoid duplication
            buffersRef.current.byId.delete(userId);
            const orderIndex = buffersRef.current.order.indexOf(userId);
            if (orderIndex !== -1) {
              buffersRef.current.order.splice(orderIndex, 1);
            }

            setStreaming(false); // Stop streaming indicator
            setPendingApprovals(existingApprovals);

            // Analyze approval contexts for ALL pending approvals
            const contexts = await Promise.all(
              existingApprovals.map(async (approval) => {
                const parsedArgs = safeJsonParseOr<Record<string, unknown>>(
                  approval.toolArgs,
                  {},
                );
                return await analyzeToolApproval(approval.toolName, parsedArgs);
              }),
            );

            // Check again after async approval analysis
            if (
              userCancelledRef.current ||
              abortControllerRef.current?.signal.aborted
            ) {
              // User cancelled during analysis - don't show dialog
              setStreaming(false);
              refreshDerived();
              return { submitted: false };
            }

            setApprovalContexts(contexts);

            // Refresh to remove the message from UI
            refreshDerived();

            // Return false = message NOT submitted, will be restored to input
            return { submitted: false };
          }
        } catch (_error) {
          // If check fails, proceed anyway (don't block user)
        }
      }

      // Start the conversation loop. If we have queued approval results from an interrupted
      // client-side execution, send them first before the new user message.
      const initialInput: Array<MessageCreate | ApprovalCreate> = [];

      if (queuedApprovalResults) {
        initialInput.push({
          type: "approval",
          approvals: queuedApprovalResults,
        });
        setQueuedApprovalResults(null);
      }

      initialInput.push({
        type: "message",
        role: "user",
        content: messageContent as unknown as MessageCreate["content"],
      });

      await processConversation(initialInput);

      // Clean up placeholders after submission
      clearPlaceholdersInText(msg);

      return { submitted: true };
    },
    [
      streaming,
      commandRunning,
      processConversation,
      refreshDerived,
      agentId,
      agentName,
      agentDescription,
      agentLastRunAt,
      handleExit,
      isExecutingTool,
      queuedApprovalResults,
      pendingApprovals,
      profileConfirmPending,
      handleAgentSelect,
      tokenStreamingEnabled,
    ],
  );

  const onSubmitRef = useRef(onSubmit);
  useEffect(() => {
    onSubmitRef.current = onSubmit;
  }, [onSubmit]);

  // Process queued messages when streaming ends
  useEffect(() => {
    if (
      !streaming &&
      messageQueue.length > 0 &&
      pendingApprovals.length === 0 &&
      !commandRunning &&
      !isExecutingTool &&
      !waitingForQueueCancelRef.current && // Don't dequeue while waiting for cancel
      !userCancelledRef.current // Don't dequeue if user just cancelled
    ) {
      const [firstMessage, ...rest] = messageQueue;
      setMessageQueue(rest);

      // Submit the first message using the normal submit flow
      // This ensures all setup (reminders, UI updates, etc.) happens correctly
      onSubmitRef.current(firstMessage);
    }
  }, [
    streaming,
    messageQueue,
    pendingApprovals,
    commandRunning,
    isExecutingTool,
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

        const approvalAbortController = new AbortController();
        toolAbortControllerRef.current = approvalAbortController;

        // Combine all decisions using snapshots
        const allDecisions = [
          ...approvalResultsSnapshot,
          ...(additionalDecision ? [additionalDecision] : []),
        ];

        // Execute approved tools and format results using shared function
        const { executeApprovalBatch } = await import(
          "../agent/approval-execution"
        );
        const executedResults = await executeApprovalBatch(
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
                appendError(chunk.tool_return);
              }
            }
            // Flush UI so completed tools show up while the batch continues
            refreshDerived();
          },
          { abortSignal: approvalAbortController.signal },
        );

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
            console.error("[BUG] Approval ID mismatch detected");
            console.error("Expected IDs:", Array.from(expectedIds));
            console.error("Sending IDs:", Array.from(sendingIds));
            throw new Error(
              "Approval ID mismatch - refusing to send mismatched IDs",
            );
          }
        }

        // Rotate to a new thinking message
        setThinkingMessage(getRandomThinkingMessage());
        refreshDerived();

        const wasAborted = approvalAbortController.signal.aborted;
        const userCancelled =
          userCancelledRef.current ||
          abortControllerRef.current?.signal.aborted;

        if (wasAborted || userCancelled) {
          // Queue results to send alongside the next user message (if not cancelled entirely)
          if (!userCancelled) {
            setQueuedApprovalResults(allResults as ApprovalResult[]);
          }
          setStreaming(false);
        } else {
          // Continue conversation with all results
          await processConversation([
            {
              type: "approval",
              approvals: allResults as ApprovalResult[],
            },
          ]);
        }
      } finally {
        // Always release the execution guard, even if an error occurred
        setIsExecutingTool(false);
        toolAbortControllerRef.current = null;
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
    ],
  );

  // Handle approval callbacks - sequential review
  const handleApproveCurrent = useCallback(async () => {
    if (isExecutingTool) return;

    const currentIndex = approvalResults.length;
    const currentApproval = pendingApprovals[currentIndex];

    if (!currentApproval) return;

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
      appendError(errorDetails);
      setStreaming(false);
      setIsExecutingTool(false);
    }
  }, [
    agentId,
    pendingApprovals,
    approvalResults,
    sendAllResults,
    appendError,
    isExecutingTool,
  ]);

  const handleApproveAlways = useCallback(
    async (scope?: "project" | "session") => {
      if (isExecutingTool) return;

      // For now, just handle the first approval with approve-always
      // TODO: Support approve-always for multiple approvals
      if (pendingApprovals.length === 0 || approvalContexts.length === 0)
        return;

      const currentIndex = approvalResults.length;
      const approvalContext = approvalContexts[currentIndex];
      if (!approvalContext) return;

      const rule = approvalContext.recommendedRule;
      const actualScope = scope || approvalContext.defaultScope;

      // Save the permission rule
      await savePermissionRule(rule, "allow", actualScope);

      // Show confirmation in transcript
      const scopeText =
        actualScope === "session" ? " (session only)" : " (project)";
      const cmdId = uid("cmd");
      buffersRef.current.byId.set(cmdId, {
        kind: "command",
        id: cmdId,
        input: "/approve-always",
        output: `Added permission: ${rule}${scopeText}`,
      });
      buffersRef.current.order.push(cmdId);
      refreshDerived();

      // Approve current tool (handleApproveCurrent manages the execution guard)
      await handleApproveCurrent();
    },
    [
      approvalResults,
      approvalContexts,
      pendingApprovals,
      handleApproveCurrent,
      refreshDerived,
      isExecutingTool,
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
          setThinkingMessage(getRandomThinkingMessage());
          await sendAllResults(decision);
        } else {
          // Not done yet, store decision and show next approval
          setApprovalResults((prev) => [...prev, decision]);
          setIsExecutingTool(false);
        }
      } catch (e) {
        const errorDetails = formatErrorDetails(e, agentId);
        appendError(errorDetails);
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
    setQueuedApprovalResults(denialResults);

    // Mark the pending approval tool calls as cancelled in the buffers
    markIncompleteToolsAsCancelled(buffersRef.current);
    refreshDerived();

    // Clear all approval state
    setPendingApprovals([]);
    setApprovalContexts([]);
    setApprovalResults([]);
    setAutoHandledResults([]);
    setAutoDeniedApprovals([]);
  }, [pendingApprovals, refreshDerived]);

  const handleModelSelect = useCallback(
    async (modelId: string) => {
      setModelSelectorOpen(false);

      // Declare cmdId outside try block so it's accessible in catch
      let cmdId: string | null = null;

      try {
        // Find the selected model from models.json first (for loading message)
        const { models } = await import("../agent/model");
        const selectedModel = models.find((m) => m.id === modelId);

        if (!selectedModel) {
          // Create a failed command in the transcript
          cmdId = uid("cmd");
          buffersRef.current.byId.set(cmdId, {
            kind: "command",
            id: cmdId,
            input: `/model ${modelId}`,
            output: `Model not found: ${modelId}`,
            phase: "finished",
            success: false,
          });
          buffersRef.current.order.push(cmdId);
          refreshDerived();
          return;
        }

        // Immediately add command to transcript with "running" phase and loading message
        cmdId = uid("cmd");
        buffersRef.current.byId.set(cmdId, {
          kind: "command",
          id: cmdId,
          input: `/model ${modelId}`,
          output: `Switching model to ${selectedModel.label}...`,
          phase: "running",
        });
        buffersRef.current.order.push(cmdId);
        refreshDerived();

        // Lock input during async operation
        setCommandRunning(true);

        // Update the agent with new model and config args
        const { updateAgentLLMConfig } = await import("../agent/modify");

        const updatedConfig = await updateAgentLLMConfig(
          agentId,
          selectedModel.handle,
          selectedModel.updateArgs,
        );
        setLlmConfig(updatedConfig);

        // After switching models, only switch toolset if it actually changes
        const { isOpenAIModel, isGeminiModel } = await import(
          "../tools/manager"
        );
        const targetToolset:
          | "codex"
          | "codex_snake"
          | "default"
          | "gemini"
          | "gemini_snake" = isOpenAIModel(selectedModel.handle ?? "")
          ? "codex"
          : isGeminiModel(selectedModel.handle ?? "")
            ? "gemini"
            : "default";

        let toolsetName:
          | "codex"
          | "codex_snake"
          | "default"
          | "gemini"
          | "gemini_snake"
          | null = null;
        if (currentToolset !== targetToolset) {
          const { switchToolsetForModel } = await import("../tools/toolset");
          toolsetName = await switchToolsetForModel(
            selectedModel.handle ?? "",
            agentId,
          );
          setCurrentToolset(toolsetName);
        }

        // Update the same command with final result (include toolset info only if changed)
        const autoToolsetLine = toolsetName
          ? `Automatically switched toolset to ${toolsetName}. Use /toolset to change back if desired.\nConsider switching to a different system prompt using /system to match.`
          : null;
        const outputLines = [
          `Switched to ${selectedModel.label}`,
          ...(autoToolsetLine ? [autoToolsetLine] : []),
        ].join("\n");

        buffersRef.current.byId.set(cmdId, {
          kind: "command",
          id: cmdId,
          input: `/model ${modelId}`,
          output: outputLines,
          phase: "finished",
          success: true,
        });
        refreshDerived();
      } catch (error) {
        // Mark command as failed (only if cmdId was created)
        const errorDetails = formatErrorDetails(error, agentId);
        if (cmdId) {
          buffersRef.current.byId.set(cmdId, {
            kind: "command",
            id: cmdId,
            input: `/model ${modelId}`,
            output: `Failed to switch model: ${errorDetails}`,
            phase: "finished",
            success: false,
          });
          refreshDerived();
        }
      } finally {
        // Unlock input
        setCommandRunning(false);
      }
    },
    [agentId, refreshDerived, currentToolset],
  );

  const handleSystemPromptSelect = useCallback(
    async (promptId: string) => {
      setSystemPromptSelectorOpen(false);

      const cmdId = uid("cmd");

      try {
        // Find the selected prompt
        const { SYSTEM_PROMPTS } = await import("../agent/promptAssets");
        const selectedPrompt = SYSTEM_PROMPTS.find((p) => p.id === promptId);

        if (!selectedPrompt) {
          buffersRef.current.byId.set(cmdId, {
            kind: "command",
            id: cmdId,
            input: `/system ${promptId}`,
            output: `System prompt not found: ${promptId}`,
            phase: "finished",
            success: false,
          });
          buffersRef.current.order.push(cmdId);
          refreshDerived();
          return;
        }

        // Immediately add command to transcript with "running" phase
        buffersRef.current.byId.set(cmdId, {
          kind: "command",
          id: cmdId,
          input: `/system ${promptId}`,
          output: `Switching system prompt to ${selectedPrompt.label}...`,
          phase: "running",
        });
        buffersRef.current.order.push(cmdId);
        refreshDerived();

        // Lock input during async operation
        setCommandRunning(true);

        // Update the agent's system prompt
        const { updateAgentSystemPrompt } = await import("../agent/modify");
        const result = await updateAgentSystemPrompt(
          agentId,
          selectedPrompt.content,
        );

        if (result.success) {
          setCurrentSystemPromptId(promptId);
          buffersRef.current.byId.set(cmdId, {
            kind: "command",
            id: cmdId,
            input: `/system ${promptId}`,
            output: `Switched system prompt to ${selectedPrompt.label}`,
            phase: "finished",
            success: true,
          });
        } else {
          buffersRef.current.byId.set(cmdId, {
            kind: "command",
            id: cmdId,
            input: `/system ${promptId}`,
            output: result.message,
            phase: "finished",
            success: false,
          });
        }
        refreshDerived();
      } catch (error) {
        const errorDetails = formatErrorDetails(error, agentId);
        buffersRef.current.byId.set(cmdId, {
          kind: "command",
          id: cmdId,
          input: `/system ${promptId}`,
          output: `Failed to switch system prompt: ${errorDetails}`,
          phase: "finished",
          success: false,
        });
        refreshDerived();
      } finally {
        setCommandRunning(false);
      }
    },
    [agentId, refreshDerived],
  );

  const handleToolsetSelect = useCallback(
    async (
      toolsetId:
        | "codex"
        | "codex_snake"
        | "default"
        | "gemini"
        | "gemini_snake",
    ) => {
      setToolsetSelectorOpen(false);

      const cmdId = uid("cmd");

      try {
        // Immediately add command to transcript with "running" phase
        buffersRef.current.byId.set(cmdId, {
          kind: "command",
          id: cmdId,
          input: `/toolset ${toolsetId}`,
          output: `Switching toolset to ${toolsetId}...`,
          phase: "running",
        });
        buffersRef.current.order.push(cmdId);
        refreshDerived();

        // Lock input during async operation
        setCommandRunning(true);

        // Force switch to the selected toolset
        const { forceToolsetSwitch } = await import("../tools/toolset");
        await forceToolsetSwitch(toolsetId, agentId);
        setCurrentToolset(toolsetId);

        // Update the command with final result
        buffersRef.current.byId.set(cmdId, {
          kind: "command",
          id: cmdId,
          input: `/toolset ${toolsetId}`,
          output: `Switched toolset to ${toolsetId}`,
          phase: "finished",
          success: true,
        });
        refreshDerived();
      } catch (error) {
        const errorDetails = formatErrorDetails(error, agentId);
        buffersRef.current.byId.set(cmdId, {
          kind: "command",
          id: cmdId,
          input: `/toolset ${toolsetId}`,
          output: `Failed to switch toolset: ${errorDetails}`,
          phase: "finished",
          success: false,
        });
        refreshDerived();
      } finally {
        // Unlock input
        setCommandRunning(false);
      }
    },
    [agentId, refreshDerived],
  );

  // Handle escape when profile confirmation is pending
  const handleProfileEscapeCancel = useCallback(() => {
    if (profileConfirmPending) {
      const { cmdId, name } = profileConfirmPending;
      buffersRef.current.byId.set(cmdId, {
        kind: "command",
        id: cmdId,
        input: `/profile load ${name}`,
        output: "Cancelled",
        phase: "finished",
        success: false,
      });
      refreshDerived();
      setProfileConfirmPending(null);
    }
  }, [profileConfirmPending, refreshDerived]);

  // Track permission mode changes for UI updates
  const [uiPermissionMode, setUiPermissionMode] = useState(
    permissionMode.getMode(),
  );

  const handlePlanApprove = useCallback(
    async (acceptEdits: boolean = false) => {
      const currentIndex = approvalResults.length;
      const approval = pendingApprovals[currentIndex];
      if (!approval) return;

      const isLast = currentIndex + 1 >= pendingApprovals.length;

      // Exit plan mode
      const newMode = acceptEdits ? "acceptEdits" : "default";
      permissionMode.setMode(newMode);
      setUiPermissionMode(newMode);

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
          tool_return: toolResult.toolReturn,
          status: toolResult.status,
          stdout: toolResult.stdout,
          stderr: toolResult.stderr,
        });

        setThinkingMessage(getRandomThinkingMessage());
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
        appendError(errorDetails);
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

  // Auto-reject ExitPlanMode if plan file doesn't exist
  useEffect(() => {
    const currentIndex = approvalResults.length;
    const approval = pendingApprovals[currentIndex];
    if (approval?.toolName === "ExitPlanMode" && !planFileExists()) {
      const planFilePath = permissionMode.getPlanFilePath();
      handlePlanKeepPlanning(
        `You must write your plan to the plan file before exiting plan mode.\n` +
          `Plan file path: ${planFilePath || "not set"}\n` +
          `Use the Write tool to create your plan, then call ExitPlanMode again.`,
      );
    }
  }, [pendingApprovals, approvalResults.length, handlePlanKeepPlanning]);

  const handleQuestionSubmit = useCallback(
    async (answers: Record<string, string>) => {
      const currentIndex = approvalResults.length;
      const approval = pendingApprovals[currentIndex];
      if (!approval) return;

      const isLast = currentIndex + 1 >= pendingApprovals.length;

      // Get questions from approval args
      const questions = getQuestionsFromApproval(approval);

      // Format the answer string like Claude Code does
      const answerParts = questions.map((q) => {
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

      setThinkingMessage(getRandomThinkingMessage());
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
    [pendingApprovals, approvalResults, sendAllResults, refreshDerived],
  );

  const handleEnterPlanModeApprove = useCallback(async () => {
    const currentIndex = approvalResults.length;
    const approval = pendingApprovals[currentIndex];
    if (!approval) return;

    const isLast = currentIndex + 1 >= pendingApprovals.length;

    // Generate plan file path
    const planFilePath = generatePlanFilePath();

    // Toggle plan mode on and store plan file path
    permissionMode.setMode("plan");
    permissionMode.setPlanFilePath(planFilePath);
    setUiPermissionMode("plan");

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

Plan file path: ${planFilePath}`;

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

    setThinkingMessage(getRandomThinkingMessage());
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
  }, [pendingApprovals, approvalResults, sendAllResults, refreshDerived]);

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

  // Live area shows only in-progress items
  const liveItems = useMemo(() => {
    return lines.filter((ln) => {
      if (!("phase" in ln)) return false;
      if (ln.kind === "command") {
        return ln.phase === "running";
      }
      if (ln.kind === "tool_call") {
        // Skip Task tool_calls - SubagentGroupDisplay handles them
        if (ln.name && isTaskTool(ln.name)) {
          return false;
        }
        // Always show other tool calls in progress
        return ln.phase !== "finished";
      }
      if (!tokenStreamingEnabled && ln.phase === "streaming") return false;
      return ln.phase === "streaming";
    });
  }, [lines, tokenStreamingEnabled]);

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
      const agentUrl = agentState?.id
        ? `https://app.letta.com/agents/${agentState.id}`
        : null;
      const statusId = `status-agent-${Date.now().toString(36)}`;
      const hints = getAgentStatusHints(
        !!continueSession,
        agentState,
        agentProvenance,
      );
      // For resumed agents, show the agent name if it has one (profile name)
      const resumedMessage = continueSession
        ? agentState?.name
          ? `Resumed **${agentState.name}**`
          : "Resumed agent"
        : "Created a new agent (use /pin to save, /pinned or /resume to switch)";

      const agentNameLine =
        !continueSession && agentState?.name
          ? `→ Agent: ${agentState.name} (use /rename to rename)`
          : "";

      const statusLines = [
        resumedMessage,
        agentNameLine,
        agentUrl ? `→ ${agentUrl}` : "",
        ...hints,
      ].filter(Boolean);

      buffersRef.current.byId.set(statusId, {
        kind: "status",
        id: statusId,
        lines: statusLines,
      });
      buffersRef.current.order.push(statusId);
      refreshDerived();
    }
  }, [
    loadingState,
    continueSession,
    messageHistory.length,
    columns,
    agentProvenance,
    agentState,
    refreshDerived,
  ]);

  return (
    <Box key={resumeKey} flexDirection="column" gap={1}>
      <Static
        key={staticRenderEpoch}
        items={staticItems}
        style={{ flexDirection: "column" }}
      >
        {(item: StaticItem, index: number) => (
          <Box key={item.id} marginTop={index > 0 ? 1 : 0}>
            {item.kind === "welcome" ? (
              <WelcomeScreen loadingState="ready" {...item.snapshot} />
            ) : item.kind === "user" ? (
              <UserMessage line={item} />
            ) : item.kind === "reasoning" ? (
              <ReasoningMessage line={item} />
            ) : item.kind === "assistant" ? (
              <AssistantMessage line={item} />
            ) : item.kind === "tool_call" ? (
              <ToolCallMessage line={item} />
            ) : item.kind === "subagent_group" ? (
              <SubagentGroupStatic agents={item.agents} />
            ) : item.kind === "error" ? (
              <ErrorMessage line={item} />
            ) : item.kind === "status" ? (
              <StatusMessage line={item} />
            ) : item.kind === "separator" ? (
              <Text dimColor>{"─".repeat(columns)}</Text>
            ) : item.kind === "command" ? (
              <CommandMessage line={item} />
            ) : null}
          </Box>
        )}
      </Static>

      <Box flexDirection="column" gap={1}>
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
            {/* Transcript */}
            {liveItems.length > 0 && pendingApprovals.length === 0 && (
              <Box flexDirection="column">
                {liveItems.map((ln) => (
                  <Box key={ln.id} marginTop={1}>
                    {ln.kind === "user" ? (
                      <UserMessage line={ln} />
                    ) : ln.kind === "reasoning" ? (
                      <ReasoningMessage line={ln} />
                    ) : ln.kind === "assistant" ? (
                      <AssistantMessage line={ln} />
                    ) : ln.kind === "tool_call" ? (
                      <ToolCallMessage line={ln} />
                    ) : ln.kind === "error" ? (
                      <ErrorMessage line={ln} />
                    ) : ln.kind === "status" ? (
                      <StatusMessage line={ln} />
                    ) : ln.kind === "command" ? (
                      <CommandMessage line={ln} />
                    ) : null}
                  </Box>
                ))}
              </Box>
            )}

            {/* Subagent group display - shows running/completed subagents */}
            <SubagentGroupDisplay />

            {/* Ensure 1 blank line above input when there are no live items */}
            {liveItems.length === 0 && <Box height={1} />}

            {/* Show exit stats when exiting */}
            {showExitStats && (
              <SessionStatsComponent
                stats={sessionStatsRef.current.getSnapshot()}
                agentId={agentId}
              />
            )}

            {/* Input row - always mounted to preserve state */}
            <Input
              visible={
                !showExitStats &&
                pendingApprovals.length === 0 &&
                !modelSelectorOpen &&
                !toolsetSelectorOpen &&
                !systemPromptSelectorOpen &&
                !agentSelectorOpen &&
                !resumeSelectorOpen &&
                !profileSelectorOpen &&
                !messageSearchOpen
              }
              streaming={
                streaming && !abortControllerRef.current?.signal.aborted
              }
              tokenCount={tokenCount}
              thinkingMessage={thinkingMessage}
              onSubmit={onSubmit}
              permissionMode={uiPermissionMode}
              onPermissionModeChange={setUiPermissionMode}
              onExit={handleExit}
              onInterrupt={handleInterrupt}
              interruptRequested={interruptRequested}
              agentId={agentId}
              agentName={agentName}
              currentModel={currentModelDisplay}
              messageQueue={messageQueue}
              onEnterQueueEditMode={handleEnterQueueEditMode}
              onEscapeCancel={
                profileConfirmPending ? handleProfileEscapeCancel : undefined
              }
            />

            {/* Model Selector - conditionally mounted as overlay */}
            {modelSelectorOpen && (
              <ModelSelector
                currentModel={
                  llmConfig?.model_endpoint_type && llmConfig?.model
                    ? `${llmConfig.model_endpoint_type}/${llmConfig.model}`
                    : undefined
                }
                currentEnableReasoner={llmConfig?.enable_reasoner}
                onSelect={handleModelSelect}
                onCancel={() => setModelSelectorOpen(false)}
              />
            )}

            {/* Toolset Selector - conditionally mounted as overlay */}
            {toolsetSelectorOpen && (
              <ToolsetSelector
                currentToolset={currentToolset ?? undefined}
                onSelect={handleToolsetSelect}
                onCancel={() => setToolsetSelectorOpen(false)}
              />
            )}

            {/* System Prompt Selector - conditionally mounted as overlay */}
            {systemPromptSelectorOpen && (
              <SystemPromptSelector
                currentPromptId={currentSystemPromptId ?? undefined}
                onSelect={handleSystemPromptSelect}
                onCancel={() => setSystemPromptSelectorOpen(false)}
              />
            )}

            {/* Agent Selector - conditionally mounted as overlay */}
            {agentSelectorOpen && (
              <AgentSelector
                currentAgentId={agentId}
                onSelect={handleAgentSelect}
                onCancel={() => setAgentSelectorOpen(false)}
              />
            )}

            {/* Subagent Manager - for managing custom subagents */}
            {subagentManagerOpen && (
              <SubagentManager onClose={() => setSubagentManagerOpen(false)} />
            )}

            {/* Resume Selector - conditionally mounted as overlay */}
            {resumeSelectorOpen && (
              <ResumeSelector
                currentAgentId={agentId}
                onSelect={async (id) => {
                  setResumeSelectorOpen(false);
                  await handleAgentSelect(id);
                }}
                onCancel={() => setResumeSelectorOpen(false)}
              />
            )}

            {/* Profile Selector - conditionally mounted as overlay */}
            {profileSelectorOpen && (
              <ProfileSelector
                currentAgentId={agentId}
                onSelect={async (id) => {
                  setProfileSelectorOpen(false);
                  await handleAgentSelect(id);
                }}
                onUnpin={(unpinAgentId) => {
                  setProfileSelectorOpen(false);
                  settingsManager.unpinBoth(unpinAgentId);
                  const cmdId = uid("cmd");
                  buffersRef.current.byId.set(cmdId, {
                    kind: "command",
                    id: cmdId,
                    input: "/pinned",
                    output: `Unpinned agent ${unpinAgentId.slice(0, 12)}`,
                    phase: "finished",
                    success: true,
                  });
                  buffersRef.current.order.push(cmdId);
                  refreshDerived();
                }}
                onCancel={() => setProfileSelectorOpen(false)}
              />
            )}

            {/* Message Search - conditionally mounted as overlay */}
            {messageSearchOpen && (
              <MessageSearch onClose={() => setMessageSearchOpen(false)} />
            )}

            {/* Plan Mode Dialog - for ExitPlanMode tool */}
            {currentApproval?.toolName === "ExitPlanMode" && (
              <>
                <Box height={1} />
                <PlanModeDialog
                  plan={readPlanFile()}
                  onApprove={() => handlePlanApprove(false)}
                  onApproveAndAcceptEdits={() => handlePlanApprove(true)}
                  onKeepPlanning={handlePlanKeepPlanning}
                />
              </>
            )}

            {/* Question Dialog - for AskUserQuestion tool */}
            {currentApproval?.toolName === "AskUserQuestion" && (
              <>
                <Box height={1} />
                <QuestionDialog
                  questions={getQuestionsFromApproval(currentApproval)}
                  onSubmit={handleQuestionSubmit}
                />
              </>
            )}

            {/* Enter Plan Mode Dialog - for EnterPlanMode tool */}
            {currentApproval?.toolName === "EnterPlanMode" && (
              <>
                <Box height={1} />
                <EnterPlanModeDialog
                  onApprove={handleEnterPlanModeApprove}
                  onReject={handleEnterPlanModeReject}
                />
              </>
            )}

            {/* Approval Dialog - for standard tools (not fancy UI tools) */}
            {currentApproval && !isFancyUITool(currentApproval.toolName) && (
              <>
                <Box height={1} />
                <ApprovalDialog
                  approvals={[currentApproval]}
                  approvalContexts={
                    approvalContexts[approvalResults.length]
                      ? [
                          approvalContexts[
                            approvalResults.length
                          ] as ApprovalContext,
                        ]
                      : []
                  }
                  progress={{
                    current: approvalResults.length + 1,
                    total: pendingApprovals.length,
                  }}
                  totalTools={
                    autoHandledResults.length + pendingApprovals.length
                  }
                  isExecuting={isExecutingTool}
                  onApproveAll={handleApproveCurrent}
                  onApproveAlways={handleApproveAlways}
                  onDenyAll={handleDenyCurrent}
                  onCancel={handleCancelApprovals}
                />
              </>
            )}
          </>
        )}
      </Box>
    </Box>
  );
}
