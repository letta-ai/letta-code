// src/cli/App.tsx

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { APIError, APIUserAbortError } from "@letta-ai/letta-client/core/error";
import type {
  AgentState,
  MessageCreate,
} from "@letta-ai/letta-client/resources/agents/agents";
import type {
  ApprovalCreate,
  Message,
} from "@letta-ai/letta-client/resources/agents/messages";
import type { LlmConfig } from "@letta-ai/letta-client/resources/models/models";
import type { StopReasonType } from "@letta-ai/letta-client/resources/runs/runs";
import { Box, Static, Text } from "ink";
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
  executeAutoAllowedTools,
} from "../agent/approval-execution";
import {
  buildApprovalRecoveryMessage,
  fetchRunErrorDetail,
  isApprovalPendingError,
  isApprovalStateDesyncError,
} from "../agent/approval-recovery";
import { prefetchAvailableModelHandles } from "../agent/available-models";
import { getResumeData } from "../agent/check-approval";
import { getClient } from "../agent/client";
import { getCurrentAgentId, setCurrentAgentId } from "../agent/context";
import { type AgentProvenance, createAgent } from "../agent/create";
import { ISOLATED_BLOCK_LABELS } from "../agent/memory";
import { sendMessageStream } from "../agent/message";
import { getModelDisplayName, getModelInfo } from "../agent/model";
import { SessionStats } from "../agent/stats";
import { INTERRUPTED_BY_USER } from "../constants";
import type { ApprovalContext } from "../permissions/analyzer";
import { type PermissionMode, permissionMode } from "../permissions/mode";
import {
  DEFAULT_COMPLETION_PROMISE,
  type RalphState,
  ralphMode,
} from "../ralph/mode";
import { updateProjectSettings } from "../settings";
import { settingsManager } from "../settings-manager";
import { telemetry } from "../telemetry";
import {
  analyzeToolApproval,
  checkToolPermission,
  executeTool,
  isGeminiModel,
  isOpenAIModel,
  savePermissionRule,
  type ToolExecutionResult,
} from "../tools/manager";
import {
  handleMcpAdd,
  handleMcpUsage,
  type McpCommandContext,
} from "./commands/mcp";
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
// ApprovalDialog removed - all approvals now render inline
import { ApprovalPreview } from "./components/ApprovalPreview";
import { ApprovalSwitch } from "./components/ApprovalSwitch";
import { AssistantMessage } from "./components/AssistantMessageRich";
import { BashCommandMessage } from "./components/BashCommandMessage";
import { CommandMessage } from "./components/CommandMessage";
import { ConversationSelector } from "./components/ConversationSelector";
import { colors } from "./components/colors";
// EnterPlanModeDialog removed - now using InlineEnterPlanModeApproval
import { ErrorMessage } from "./components/ErrorMessageRich";
import { FeedbackDialog } from "./components/FeedbackDialog";
import { HelpDialog } from "./components/HelpDialog";
import { Input } from "./components/InputRich";
import { McpConnectFlow } from "./components/McpConnectFlow";
import { McpSelector } from "./components/McpSelector";
import { MemoryTabViewer } from "./components/MemoryTabViewer";
import { MessageSearch } from "./components/MessageSearch";
import { ModelSelector } from "./components/ModelSelector";
import { NewAgentDialog } from "./components/NewAgentDialog";
import { PendingApprovalStub } from "./components/PendingApprovalStub";
import { PinDialog, validateAgentName } from "./components/PinDialog";
// QuestionDialog removed - now using InlineQuestionApproval
import { ReasoningMessage } from "./components/ReasoningMessageRich";

import { formatUsageStats } from "./components/SessionStats";
// InlinePlanApproval kept for easy rollback if needed
// import { InlinePlanApproval } from "./components/InlinePlanApproval";
import { StatusMessage } from "./components/StatusMessage";
import { SubagentGroupDisplay } from "./components/SubagentGroupDisplay";
import { SubagentGroupStatic } from "./components/SubagentGroupStatic";
import { SubagentManager } from "./components/SubagentManager";
import { SystemPromptSelector } from "./components/SystemPromptSelector";
import { ToolCallMessage } from "./components/ToolCallMessageRich";
import { ToolsetSelector } from "./components/ToolsetSelector";
import { UserMessage } from "./components/UserMessageRich";
import { WelcomeScreen } from "./components/WelcomeScreen";
import { AnimationProvider } from "./contexts/AnimationContext";
import {
  appendStreamingOutput,
  type Buffers,
  createBuffers,
  type Line,
  markIncompleteToolsAsCancelled,
  onChunk,
  setToolCallsRunning,
  toLines,
} from "./helpers/accumulator";
import { backfillBuffers } from "./helpers/backfill";
import {
  type AdvancedDiffSuccess,
  computeAdvancedDiff,
  parsePatchToAdvancedDiff,
} from "./helpers/diff";
import { formatErrorDetails } from "./helpers/errorFormatter";
import { parsePatchOperations } from "./helpers/formatArgsDisplay";
import {
  buildMemoryReminder,
  parseMemoryPreference,
} from "./helpers/memoryReminder";
import {
  buildMessageContentFromDisplay,
  clearPlaceholdersInText,
  resolvePlaceholders,
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
  getSnapshot as getSubagentSnapshot,
  interruptActiveSubagents,
  subscribe as subscribeToSubagents,
} from "./helpers/subagentState";
import { getRandomThinkingVerb } from "./helpers/thinkingMessages";
import {
  isFileEditTool,
  isFileWriteTool,
  isPatchTool,
  isShellTool,
} from "./helpers/toolNameMapping";
import {
  alwaysRequiresUserInput,
  isTaskTool,
} from "./helpers/toolNameMapping.js";
import { useSuspend } from "./hooks/useSuspend/useSuspend.ts";
import { useSyncedState } from "./hooks/useSyncedState";
import { useTerminalRows, useTerminalWidth } from "./hooks/useTerminalWidth";

// Used only for terminal resize, not for dialog dismissal (see PR for details)
const CLEAR_SCREEN_AND_HOME = "\u001B[2J\u001B[H";
const MIN_RESIZE_DELTA = 2;

// Eager approval checking is now CONDITIONAL (LET-7101):
// - Enabled when resuming a session (--resume, --continue, or startupApprovals exist)
// - Disabled for normal messages (lazy recovery handles edge cases)
// This saves ~2s latency per message in the common case.

// Feature flag: Eagerly cancel streams client-side when user presses ESC
// When true (default), immediately abort the stream after calling .cancel()
// This provides instant feedback to the user without waiting for backend acknowledgment
// When false, wait for backend to send "cancelled" stop_reason (useful for testing backend behavior)
const EAGER_CANCEL = true;

// Maximum retries for transient LLM API errors (matches headless.ts)
const LLM_API_ERROR_MAX_RETRIES = 3;

// Message shown when user interrupts the stream
const INTERRUPT_MESSAGE =
  "Interrupted – tell the agent what to do differently. Something went wrong? Use /feedback to report the issue.";

// tiny helper for unique ids (avoid overwriting prior user lines)
function uid(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Send desktop notification via terminal bell
// Modern terminals (iTerm2, Ghostty, WezTerm, Kitty) convert this to a desktop
// notification when the terminal is not focused
function sendDesktopNotification() {
  process.stdout.write("\x07");
}

// Check if error is retriable based on stop reason and run metadata
async function isRetriableError(
  stopReason: StopReasonType,
  lastRunId: string | null | undefined,
): Promise<boolean> {
  // Primary check: backend sets stop_reason=llm_api_error for LLMError exceptions
  if (stopReason === "llm_api_error") return true;

  // Early exit for stop reasons that should never be retried
  const nonRetriableReasons: StopReasonType[] = [
    "cancelled",
    "requires_approval",
    "max_steps",
    "max_tokens_exceeded",
    "context_window_overflow_in_system_prompt",
    "end_turn",
    "tool_rule",
    "no_tool_call",
  ];
  if (nonRetriableReasons.includes(stopReason)) return false;

  // Fallback check: for error-like stop_reasons, check metadata for retriable patterns
  // This handles cases where the backend sends a generic error stop_reason but the
  // underlying cause is a transient LLM/network issue that should be retried
  if (lastRunId) {
    try {
      const client = await getClient();
      const run = await client.runs.retrieve(lastRunId);
      const metaError = run.metadata?.error as
        | {
            error_type?: string;
            detail?: string;
            // Handle nested error structure (error.error) that can occur in some edge cases
            error?: { error_type?: string; detail?: string };
          }
        | undefined;

      // Check for llm_error at top level or nested (handles error.error nesting)
      const errorType = metaError?.error_type ?? metaError?.error?.error_type;
      if (errorType === "llm_error") return true;

      // Fallback: detect LLM provider errors from detail even if misclassified
      // This handles edge cases where streaming errors weren't properly converted to LLMError
      // Patterns are derived from handle_llm_error() message formats in the backend
      const detail = metaError?.detail ?? metaError?.error?.detail ?? "";
      const llmProviderPatterns = [
        "Anthropic API error", // anthropic_client.py:759
        "OpenAI API error", // openai_client.py:1034
        "Google Vertex API error", // google_vertex_client.py:848
        "overloaded", // anthropic_client.py:753 - used for LLMProviderOverloaded
        "api_error", // Anthropic SDK error type field
        "Network error", // Transient network failures during streaming
        "Connection error during Anthropic streaming", // Peer disconnections, incomplete chunked reads
      ];
      if (llmProviderPatterns.some((pattern) => detail.includes(pattern))) {
        return true;
      }

      return false;
    } catch {
      return false;
    }
  }
  return false;
}

// Save current agent as lastAgent before exiting
// This ensures subagent overwrites during the session don't persist
function saveLastAgentBeforeExit() {
  try {
    const currentAgentId = getCurrentAgentId();
    settingsManager.updateLocalProjectSettings({ lastAgent: currentAgentId });
    settingsManager.updateSettings({ lastAgent: currentAgentId });
  } catch {
    // Ignore if no agent context set
  }
}

// Get plan mode system reminder if in plan mode
function getPlanModeReminder(): string {
  if (permissionMode.getMode() !== "plan") {
    return "";
  }

  const planFilePath = permissionMode.getPlanFilePath();

  // Generate dynamic reminder with plan file path
  return `<system-reminder>
      Plan mode is active. The user indicated that they do not want you to execute yet -- you MUST NOT make any edits (with the exception of the plan file mentioned below), run any non-readonly tools (including changing configs or making commits), or otherwise make any changes to the system. This supersedes any other instructions you have received.

## Plan File Info:
${planFilePath ? `No plan file exists yet. You should create your plan at ${planFilePath} using a write tool (e.g. Write, ApplyPatch, etc. depending on your toolset).` : "No plan file path assigned."}

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
function _readPlanFile(): string {
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

// Parse /ralph or /yolo-ralph command arguments
function parseRalphArgs(input: string): {
  prompt: string | null;
  completionPromise: string | null | undefined; // undefined = use default, null = no promise
  maxIterations: number;
} {
  let rest = input.replace(/^\/(yolo-)?ralph\s*/, "");

  // Extract --completion-promise "value" or --completion-promise 'value'
  // Also handles --completion-promise "" or none for opt-out
  let completionPromise: string | null | undefined;
  const promiseMatch = rest.match(/--completion-promise\s+["']([^"']*)["']/);
  if (promiseMatch) {
    const val = promiseMatch[1] ?? "";
    completionPromise = val === "" || val.toLowerCase() === "none" ? null : val;
    rest = rest.replace(/--completion-promise\s+["'][^"']*["']\s*/, "");
  }

  // Extract --max-iterations N
  const maxMatch = rest.match(/--max-iterations\s+(\d+)/);
  const maxIterations = maxMatch?.[1] ? parseInt(maxMatch[1], 10) : 0;
  rest = rest.replace(/--max-iterations\s+\d+\s*/, "");

  // Remaining text is the inline prompt (may be quoted)
  const prompt = rest.trim().replace(/^["']|["']$/g, "") || null;
  return { prompt, completionPromise, maxIterations };
}

// Build Ralph first-turn reminder (when activating)
// Uses exact wording from claude-code/plugins/ralph-wiggum/scripts/setup-ralph-loop.sh
function buildRalphFirstTurnReminder(state: RalphState): string {
  const iterInfo =
    state.maxIterations > 0
      ? `${state.currentIteration}/${state.maxIterations}`
      : `${state.currentIteration}`;

  let reminder = `<system-reminder>
🔄 Ralph Wiggum mode activated (iteration ${iterInfo})
`;

  if (state.completionPromise) {
    reminder += `
═══════════════════════════════════════════════════════════
RALPH LOOP COMPLETION PROMISE
═══════════════════════════════════════════════════════════

To complete this loop, output this EXACT text:
  <promise>${state.completionPromise}</promise>

STRICT REQUIREMENTS (DO NOT VIOLATE):
  ✓ Use <promise> XML tags EXACTLY as shown above
  ✓ The statement MUST be completely and unequivocally TRUE
  ✓ Do NOT output false statements to exit the loop
  ✓ Do NOT lie even if you think you should exit

IMPORTANT - Do not circumvent the loop:
  Even if you believe you're stuck, the task is impossible,
  or you've been running too long - you MUST NOT output a
  false promise statement. The loop is designed to continue
  until the promise is GENUINELY TRUE. Trust the process.

  If the loop should stop, the promise statement will become
  true naturally. Do not force it by lying.
═══════════════════════════════════════════════════════════
`;
  } else {
    reminder += `
No completion promise set - loop runs until --max-iterations or ESC/Shift+Tab to exit.
`;
  }

  reminder += `</system-reminder>`;
  return reminder;
}

// Build Ralph continuation reminder (on subsequent iterations)
// Exact format from claude-code/plugins/ralph-wiggum/hooks/stop-hook.sh line 160
function buildRalphContinuationReminder(state: RalphState): string {
  const iterInfo =
    state.maxIterations > 0
      ? `${state.currentIteration}/${state.maxIterations}`
      : `${state.currentIteration}`;

  if (state.completionPromise) {
    return `<system-reminder>
🔄 Ralph iteration ${iterInfo} | To stop: output <promise>${state.completionPromise}</promise> (ONLY when statement is TRUE - do not lie to exit!)
</system-reminder>`;
  } else {
    return `<system-reminder>
🔄 Ralph iteration ${iterInfo} | No completion promise set - loop runs infinitely
</system-reminder>`;
  }
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
  | {
      // Preview content committed early during approval to enable flicker-free UI
      // When an approval's content is tall enough to overflow the viewport,
      // we commit the preview to static and only show small approval options in dynamic
      kind: "approval_preview";
      id: string;
      toolCallId: string;
      toolName: string;
      toolArgs: string;
      // Optional precomputed/cached data for rendering
      precomputedDiff?: AdvancedDiffSuccess;
      planContent?: string; // For ExitPlanMode
      planFilePath?: string; // For ExitPlanMode
    }
  | Line;

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
  agentProvenance = null,
  releaseNotes = null,
}: {
  agentId: string;
  agentState?: AgentState | null;
  conversationId: string; // Required: created at startup
  loadingState?:
    | "assembling"
    | "importing"
    | "initializing"
    | "checking"
    | "ready";
  continueSession?: boolean;
  startupApproval?: ApprovalRequest | null; // Deprecated: use startupApprovals
  startupApprovals?: ApprovalRequest[];
  messageHistory?: Message[];
  resumedExistingConversation?: boolean; // True if we explicitly resumed via --resume
  tokenStreaming?: boolean;
  agentProvenance?: AgentProvenance | null;
  releaseNotes?: string | null; // Markdown release notes to display above header
}) {
  // Warm the model-access cache in the background so /model is fast on first open.
  useEffect(() => {
    prefetchAvailableModelHandles();
  }, []);

  // Track current agent (can change when swapping)
  const [agentId, setAgentId] = useState(initialAgentId);
  const [agentState, setAgentState] = useState(initialAgentState);

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

  const resumeKey = useSuspend();

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
      conversationIdRef.current = initialConversationId;
      setConversationId(initialConversationId);
    }
  }, [initialConversationId]);

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
    | "toolset"
    | "system"
    | "agent"
    | "resume"
    | "conversations"
    | "search"
    | "subagent"
    | "feedback"
    | "memory"
    | "pin"
    | "new"
    | "mcp"
    | "mcp-connect"
    | "help"
    | null;
  const [activeOverlay, setActiveOverlay] = useState<ActiveOverlay>(null);
  const [feedbackPrefill, setFeedbackPrefill] = useState("");
  const [modelSelectorOptions, setModelSelectorOptions] = useState<{
    filterProvider?: string;
    forceRefresh?: boolean;
  }>({});
  const closeOverlay = useCallback(() => {
    setActiveOverlay(null);
    setFeedbackPrefill("");
    setModelSelectorOptions({});
  }, []);

  // Pin dialog state
  const [pinDialogLocal, setPinDialogLocal] = useState(false);

  // Derived: check if any selector/overlay is open (blocks queue processing and hides input)
  const anySelectorOpen = activeOverlay !== null;

  // Other model/agent state
  const [currentSystemPromptId, setCurrentSystemPromptId] = useState<
    string | null
  >("default");
  const [currentToolset, setCurrentToolset] = useState<
    | "codex"
    | "codex_snake"
    | "default"
    | "gemini"
    | "gemini_snake"
    | "none"
    | null
  >(null);
  const [llmConfig, setLlmConfig] = useState<LlmConfig | null>(null);
  const llmConfigRef = useRef(llmConfig);
  useEffect(() => {
    llmConfigRef.current = llmConfig;
  }, [llmConfig]);
  const [currentModelId, setCurrentModelId] = useState<string | null>(null);
  const [agentName, setAgentName] = useState<string | null>(null);
  const [agentDescription, setAgentDescription] = useState<string | null>(null);
  const [agentLastRunAt, setAgentLastRunAt] = useState<string | null>(null);
  const currentModelLabel =
    llmConfig?.model_endpoint_type && llmConfig?.model
      ? `${llmConfig.model_endpoint_type}/${llmConfig.model}`
      : (llmConfig?.model ?? null);
  const currentModelDisplay = currentModelLabel
    ? (getModelDisplayName(currentModelLabel) ??
      currentModelLabel.split("/").pop())
    : null;
  const currentModelProvider = llmConfig?.provider_name ?? null;

  // Token streaming preference (can be toggled at runtime)
  const [tokenStreamingEnabled, setTokenStreamingEnabled] =
    useState(tokenStreaming);

  // Live, approximate token counter (resets each turn)
  const [tokenCount, setTokenCount] = useState(0);

  // Current thinking message (rotates each turn)
  const [thinkingMessage, setThinkingMessage] = useState(
    getRandomThinkingVerb(),
  );

  // Session stats tracking
  const sessionStatsRef = useRef(new SessionStats());

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

  // Show exit stats on exit (double Ctrl+C)
  const [showExitStats, setShowExitStats] = useState(false);

  // Track if we've sent the session context for this CLI session
  const hasSentSessionContextRef = useRef(false);

  // Track conversation turn count for periodic memory reminders
  const turnCountRef = useRef(0);

  // Track last notified permission mode to detect changes
  const lastNotifiedModeRef = useRef<PermissionMode>("default");

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

  // Retry counter for transient LLM API errors (ref for synchronous access in loop)
  const llmApiErrorRetriesRef = useRef(0);

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
  const columns = useTerminalWidth();
  const terminalRows = useTerminalRows();
  const prevColumnsRef = useRef(columns);
  const lastClearedColumnsRef = useRef(columns);
  const pendingResizeRef = useRef(false);
  const pendingResizeColumnsRef = useRef<number | null>(null);
  const [staticRenderEpoch, setStaticRenderEpoch] = useState(0);
  const resizeClearTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isInitialResizeRef = useRef(true);
  useEffect(() => {
    const prev = prevColumnsRef.current;
    if (columns === prev) return;

    // Clear pending debounced operation on any resize
    if (resizeClearTimeout.current) {
      clearTimeout(resizeClearTimeout.current);
      resizeClearTimeout.current = null;
    }

    // Skip initial mount - no clearing needed on first render
    if (isInitialResizeRef.current) {
      isInitialResizeRef.current = false;
      prevColumnsRef.current = columns;
      lastClearedColumnsRef.current = columns;
      return;
    }

    const delta = Math.abs(columns - prev);
    const isMinorJitter = delta > 0 && delta < MIN_RESIZE_DELTA;
    if (streaming) {
      if (isMinorJitter) {
        prevColumnsRef.current = columns;
        return;
      }

      // Defer clear/remount until streaming ends to avoid Ghostty flicker.
      pendingResizeRef.current = true;
      pendingResizeColumnsRef.current = columns;
      prevColumnsRef.current = columns;
      return;
    }

    if (columns === lastClearedColumnsRef.current) {
      pendingResizeRef.current = false;
      pendingResizeColumnsRef.current = null;
      prevColumnsRef.current = columns;
      return;
    }

    // Debounce to avoid flicker from rapid resize events (e.g., drag resize, Ghostty focus)
    // Clear and remount must happen together - otherwise Static re-renders on top of existing content
    const scheduledColumns = columns;
    resizeClearTimeout.current = setTimeout(() => {
      resizeClearTimeout.current = null;
      if (
        typeof process !== "undefined" &&
        process.stdout &&
        "write" in process.stdout &&
        process.stdout.isTTY
      ) {
        process.stdout.write(CLEAR_SCREEN_AND_HOME);
      }
      setStaticRenderEpoch((epoch) => epoch + 1);
      lastClearedColumnsRef.current = scheduledColumns;
    }, 150);

    prevColumnsRef.current = columns;

    // Cleanup on unmount
    return () => {
      if (resizeClearTimeout.current) {
        clearTimeout(resizeClearTimeout.current);
        resizeClearTimeout.current = null;
      }
    };
  }, [columns, streaming]);

  useEffect(() => {
    if (streaming) {
      if (resizeClearTimeout.current) {
        clearTimeout(resizeClearTimeout.current);
        resizeClearTimeout.current = null;
        pendingResizeRef.current = true;
        pendingResizeColumnsRef.current = columns;
      }
      return;
    }

    if (!pendingResizeRef.current) return;

    const pendingColumns = pendingResizeColumnsRef.current;
    pendingResizeRef.current = false;
    pendingResizeColumnsRef.current = null;

    if (pendingColumns === null) return;
    if (pendingColumns === lastClearedColumnsRef.current) return;

    if (
      typeof process !== "undefined" &&
      process.stdout &&
      "write" in process.stdout &&
      process.stdout.isTTY
    ) {
      process.stdout.write(CLEAR_SCREEN_AND_HOME);
    }
    setStaticRenderEpoch((epoch) => epoch + 1);
    lastClearedColumnsRef.current = pendingColumns;
  }, [columns, streaming]);

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
        emittedIdsRef.current.add(id);
        newlyCommitted.push({ ...ln });
        // Note: We intentionally don't cleanup precomputedDiffs here because
        // the Static area renders AFTER this function returns (on next React tick),
        // and the diff needs to be available for ToolCallMessage to render.
        // The diffs will be cleaned up when the session ends or on next session start.
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

  // Cache precomputed diffs from approval dialogs for tool return rendering
  // Key: toolCallId or "toolCallId:filePath" for Patch operations
  const precomputedDiffsRef = useRef<Map<string, AdvancedDiffSuccess>>(
    new Map(),
  );

  // Store the last plan file path for post-approval rendering
  // (needed because plan mode is exited before rendering the result)
  const lastPlanFilePathRef = useRef<string | null>(null);

  // Track which approval tool call IDs have had their previews eagerly committed
  // This prevents double-committing when the approval changes
  const eagerCommittedPreviewsRef = useRef<Set<string>>(new Set());

  // Recompute UI state from buffers after each streaming chunk
  const refreshDerived = useCallback(() => {
    const b = buffersRef.current;
    setTokenCount(b.tokenCount);
    const newLines = toLines(b);
    setLines(newLines);
    commitEligibleLines(b);
  }, [commitEligibleLines]);

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
          refreshDerived();
        }
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
      if (process.env.DEBUG) {
        console.log(
          `[DEBUG] Header: resumedExistingConversation=${resumedExistingConversation}, messageHistory.length=${messageHistory.length}`,
        );
      }
      const headerMessage = isResumingConversation
        ? `Resuming conversation with **${agentName}**`
        : `Starting new conversation with **${agentName}**`;

      // Command hints - for pinned agents show /memory, for unpinned show /pin
      const commandHints = isPinned
        ? [
            "→ **/agents**    list all agents",
            "→ **/resume**    resume a previous conversation",
            "→ **/memory**    view your agent's memory blocks",
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

      // Add release notes first (above everything) - same styling as rest of status block
      if (releaseNotes) {
        statusLines.push(releaseNotes);
        statusLines.push(""); // blank line separator
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
    resumedExistingConversation,
    releaseNotes,
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

          // Derive model ID from llm_config for ModelSelector
          const agentModelHandle =
            agent.llm_config.model_endpoint_type && agent.llm_config.model
              ? `${agent.llm_config.model_endpoint_type}/${agent.llm_config.model}`
              : agent.llm_config.model;
          const modelInfo = getModelInfo(agentModelHandle || "");
          if (modelInfo) {
            setCurrentModelId(modelInfo.id);
          } else {
            setCurrentModelId(agentModelHandle || null);
          }

          // Derive toolset from agent's model (not persisted, computed on resume)
          if (agentModelHandle) {
            const derivedToolset = isOpenAIModel(agentModelHandle)
              ? "codex"
              : isGeminiModel(agentModelHandle)
                ? "gemini"
                : "default";
            setCurrentToolset(derivedToolset);
          }
        } catch (error) {
          console.error("Error fetching agent config:", error);
        }
      };
      fetchConfig();
    }
  }, [loadingState, agentId]);

  // Helper to append an error to the transcript
  // Also tracks the error in telemetry so we know an error was shown
  const appendError = useCallback(
    (message: string, skipTelemetry = false) => {
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

      // Track error in telemetry (unless explicitly skipped for user-initiated actions)
      if (!skipTelemetry) {
        telemetry.trackError("ui_error", text, "error_display", {
          modelId: currentModelId || undefined,
        });
      }
    },
    [refreshDerived, currentModelId],
  );

  // Core streaming function - iterative loop that processes conversation turns
  const processConversation = useCallback(
    async (
      initialInput: Array<MessageCreate | ApprovalCreate>,
      options?: { allowReentry?: boolean; submissionGeneration?: number },
    ): Promise<void> => {
      // Helper function for Ralph Wiggum mode continuation
      // Defined here to have access to buffersRef, processConversation via closure
      const handleRalphContinuation = () => {
        const ralphState = ralphMode.getState();

        // Extract LAST assistant message from buffers to check for promise
        // (We only want to check the most recent response, not the entire transcript)
        const lines = toLines(buffersRef.current);
        const assistantLines = lines.filter(
          (l): l is Line & { kind: "assistant" } => l.kind === "assistant",
        );
        const lastAssistantText =
          assistantLines.length > 0
            ? (assistantLines[assistantLines.length - 1]?.text ?? "")
            : "";

        // Check for completion promise
        if (ralphMode.checkForPromise(lastAssistantText)) {
          // Promise matched - exit ralph mode
          const wasYolo = ralphState.isYolo;
          ralphMode.deactivate();
          setUiRalphActive(false);
          if (wasYolo) {
            permissionMode.setMode("default");
          }

          // Add completion status to transcript
          const statusId = uid("status");
          buffersRef.current.byId.set(statusId, {
            kind: "status",
            id: statusId,
            lines: [
              `✅ Ralph loop complete: promise detected after ${ralphState.currentIteration} iteration(s)`,
            ],
          });
          buffersRef.current.order.push(statusId);
          refreshDerived();
          return;
        }

        // Check iteration limit
        if (!ralphMode.shouldContinue()) {
          // Max iterations reached - exit ralph mode
          const wasYolo = ralphState.isYolo;
          ralphMode.deactivate();
          setUiRalphActive(false);
          if (wasYolo) {
            permissionMode.setMode("default");
          }

          // Add status to transcript
          const statusId = uid("status");
          buffersRef.current.byId.set(statusId, {
            kind: "status",
            id: statusId,
            lines: [
              `🛑 Ralph loop: Max iterations (${ralphState.maxIterations}) reached`,
            ],
          });
          buffersRef.current.order.push(statusId);
          refreshDerived();
          return;
        }

        // Continue loop - increment iteration and re-send prompt
        ralphMode.incrementIteration();
        const newState = ralphMode.getState();
        const systemMsg = buildRalphContinuationReminder(newState);

        // Re-inject original prompt with ralph reminder prepended
        // Use setTimeout to avoid blocking the current render cycle
        setTimeout(() => {
          processConversation(
            [
              {
                type: "message",
                role: "user",
                content: `${systemMsg}\n\n${newState.originalPrompt}`,
              },
            ],
            { allowReentry: true },
          );
        }, 0);
      };

      // Copy so we can safely mutate for retry recovery flows
      const currentInput = [...initialInput];
      const allowReentry = options?.allowReentry ?? false;

      // Use provided generation (from onSubmit) or capture current
      // This allows detecting if ESC was pressed during async work before this function was called
      const myGeneration =
        options?.submissionGeneration ?? conversationGenerationRef.current;

      // Check if we're already stale (ESC was pressed while we were queued in onSubmit).
      // This can happen if ESC was pressed during async work before processConversation was called.
      // We check early to avoid setting state (streaming, etc.) for stale conversations.
      if (myGeneration !== conversationGenerationRef.current) {
        return;
      }

      // Guard against concurrent processConversation calls
      // This can happen if user submits two messages in quick succession
      // Uses dedicated ref (not streamingRef) since streaming may be set early for UI responsiveness
      if (processingConversationRef.current > 0 && !allowReentry) {
        return;
      }
      processingConversationRef.current += 1;

      // Reset retry counter for new conversation turns (fresh budget per user message)
      if (!allowReentry) {
        llmApiErrorRetriesRef.current = 0;
      }

      // Track last run ID for error reporting (accessible in catch block)
      let currentRunId: string | undefined;

      try {
        // Check if user hit escape before we started
        if (userCancelledRef.current) {
          userCancelledRef.current = false; // Reset for next time
          return;
        }

        // Double-check we haven't become stale between entry and try block
        if (myGeneration !== conversationGenerationRef.current) {
          return;
        }

        setStreaming(true);
        abortControllerRef.current = new AbortController();

        // Clear any stale pending tool calls from previous turns
        // If we're sending a new message, old pending state is no longer relevant
        // Pass false to avoid setting interrupted=true, which causes race conditions
        // with concurrent processConversation calls reading the flag
        markIncompleteToolsAsCancelled(buffersRef.current, false);
        // Reset interrupted flag since we're starting a fresh stream
        buffersRef.current.interrupted = false;

        // Clear completed subagents from the UI when starting a new turn
        clearCompletedSubagents();

        while (true) {
          // Capture the signal BEFORE any async operations
          // This prevents a race where handleInterrupt nulls the ref during await
          const signal = abortControllerRef.current?.signal;

          // Check if cancelled before starting new stream
          if (signal?.aborted) {
            const isStaleAtAbort =
              myGeneration !== conversationGenerationRef.current;
            // Only set streaming=false if this is the current generation.
            // If stale, a newer processConversation might be running and we shouldn't affect its UI.
            if (!isStaleAtAbort) {
              setStreaming(false);
            }
            return;
          }

          // Stream one turn - use ref to always get the latest conversationId
          // Wrap in try-catch to handle pre-stream desync errors (when sendMessageStream
          // throws before streaming begins, e.g., retry after LLM error when backend
          // already cleared the approval)
          let stream: Awaited<ReturnType<typeof sendMessageStream>>;
          try {
            stream = await sendMessageStream(
              conversationIdRef.current,
              currentInput,
              { agentId: agentIdRef.current },
            );
          } catch (preStreamError) {
            // Check if this is a pre-stream approval desync error
            const hasApprovalInPayload = currentInput.some(
              (item) => item?.type === "approval",
            );

            if (hasApprovalInPayload) {
              // Extract error detail from APIError (handles both direct and nested structures)
              // Direct: e.error.detail | Nested: e.error.error.detail (matches formatErrorDetails)
              let errorDetail = "";
              if (
                preStreamError instanceof APIError &&
                preStreamError.error &&
                typeof preStreamError.error === "object"
              ) {
                const errObj = preStreamError.error as Record<string, unknown>;
                // Check nested structure first: e.error.error.detail
                if (
                  errObj.error &&
                  typeof errObj.error === "object" &&
                  "detail" in errObj.error
                ) {
                  const nested = errObj.error as Record<string, unknown>;
                  errorDetail =
                    typeof nested.detail === "string" ? nested.detail : "";
                }
                // Fallback to direct structure: e.error.detail
                if (!errorDetail && typeof errObj.detail === "string") {
                  errorDetail = errObj.detail;
                }
              }
              // Final fallback: use Error.message
              if (!errorDetail && preStreamError instanceof Error) {
                errorDetail = preStreamError.message;
              }

              // If desync detected and retries available, recover with keep-alive prompt
              if (
                isApprovalStateDesyncError(errorDetail) &&
                llmApiErrorRetriesRef.current < LLM_API_ERROR_MAX_RETRIES
              ) {
                llmApiErrorRetriesRef.current += 1;

                // Show transient status (matches post-stream desync handler UX)
                const statusId = uid("status");
                buffersRef.current.byId.set(statusId, {
                  kind: "status",
                  id: statusId,
                  lines: [
                    "Approval state desynced; resending keep-alive recovery prompt...",
                  ],
                });
                buffersRef.current.order.push(statusId);
                refreshDerived();

                // Swap payload to recovery message (or strip stale approvals)
                const isApprovalOnlyPayload =
                  hasApprovalInPayload && currentInput.length === 1;
                if (isApprovalOnlyPayload) {
                  currentInput.splice(
                    0,
                    currentInput.length,
                    buildApprovalRecoveryMessage(),
                  );
                } else {
                  // Mixed payload: strip stale approvals, keep user message
                  const messageItems = currentInput.filter(
                    (item) => item?.type !== "approval",
                  );
                  if (messageItems.length > 0) {
                    currentInput.splice(
                      0,
                      currentInput.length,
                      ...messageItems,
                    );
                  } else {
                    currentInput.splice(
                      0,
                      currentInput.length,
                      buildApprovalRecoveryMessage(),
                    );
                  }
                }

                // Remove transient status before retry
                buffersRef.current.byId.delete(statusId);
                buffersRef.current.order = buffersRef.current.order.filter(
                  (id) => id !== statusId,
                );
                refreshDerived();

                // Reset interrupted flag so retry stream chunks are processed
                buffersRef.current.interrupted = false;
                continue;
              }
            }

            // Not a recoverable desync - re-throw to outer catch
            throw preStreamError;
          }

          // Check again after network call - user may have pressed Escape during sendMessageStream
          if (signal?.aborted) {
            const isStaleAtAbort =
              myGeneration !== conversationGenerationRef.current;
            // Only set streaming=false if this is the current generation.
            // If stale, a newer processConversation might be running and we shouldn't affect its UI.
            if (!isStaleAtAbort) {
              setStreaming(false);
            }
            return;
          }

          // Define callback to sync agent state on first message chunk
          // This ensures the UI shows the correct model as early as possible
          const syncAgentState = async () => {
            try {
              const client = await getClient();
              const agent = await client.agents.retrieve(agentIdRef.current);

              // Check if the model has changed by comparing llm_config
              const currentModel = llmConfigRef.current?.model;
              const currentEndpoint = llmConfigRef.current?.model_endpoint_type;
              const agentModel = agent.llm_config.model;
              const agentEndpoint = agent.llm_config.model_endpoint_type;

              if (
                currentModel !== agentModel ||
                currentEndpoint !== agentEndpoint
              ) {
                // Model has changed - update local state
                setLlmConfig(agent.llm_config);

                // Derive model ID from llm_config for ModelSelector
                // Try to find matching model by handle in models.json
                const { getModelInfo } = await import("../agent/model");
                const agentModelHandle =
                  agent.llm_config.model_endpoint_type && agent.llm_config.model
                    ? `${agent.llm_config.model_endpoint_type}/${agent.llm_config.model}`
                    : agent.llm_config.model;

                const modelInfo = getModelInfo(agentModelHandle || "");
                if (modelInfo) {
                  setCurrentModelId(modelInfo.id);
                } else {
                  // Model not in models.json (e.g., BYOK model) - use handle as ID
                  setCurrentModelId(agentModelHandle || null);
                }

                // Also update agent state if other fields changed
                setAgentName(agent.name);
                setAgentDescription(agent.description ?? null);
                const lastRunCompletion = (
                  agent as { last_run_completion?: string }
                ).last_run_completion;
                setAgentLastRunAt(lastRunCompletion ?? null);
              }
            } catch (error) {
              // Silently fail - don't interrupt the conversation flow
              console.error("Failed to sync agent state:", error);
            }
          };

          const {
            stopReason,
            approval,
            approvals,
            apiDurationMs,
            lastRunId,
            fallbackError,
          } = await drainStreamWithResume(
            stream,
            buffersRef.current,
            refreshDerivedThrottled,
            signal, // Use captured signal, not ref (which may be nulled by handleInterrupt)
            syncAgentState,
          );

          // Update currentRunId for error reporting in catch block
          currentRunId = lastRunId ?? undefined;

          // Track API duration
          sessionStatsRef.current.endTurn(apiDurationMs);
          sessionStatsRef.current.updateUsageFromBuffers(buffersRef.current);

          const wasInterrupted = !!buffersRef.current.interrupted;
          const wasAborted = !!signal?.aborted;
          let stopReasonToHandle = wasAborted ? "cancelled" : stopReason;

          // Check if this conversation became stale while the stream was running.
          // If stale, a newer processConversation is running and we shouldn't modify UI state.
          const isStaleAfterDrain =
            myGeneration !== conversationGenerationRef.current;

          // If this conversation is stale, exit without modifying UI state.
          // A newer conversation is running and should control the UI.
          if (isStaleAfterDrain) {
            return;
          }

          // Immediate refresh after stream completes to show final state unless
          // the user already cancelled (handleInterrupt rendered the UI).
          if (!wasInterrupted) {
            refreshDerived();
          }

          // If the turn was interrupted client-side but the backend had already emitted
          // requires_approval, treat it as a cancel. This avoids re-entering approval flow
          // and keeps queue-cancel flags consistent with the normal cancel branch below.
          if (wasInterrupted && stopReasonToHandle === "requires_approval") {
            stopReasonToHandle = "cancelled";
          }

          // Case 1: Turn ended normally
          if (stopReasonToHandle === "end_turn") {
            setStreaming(false);
            llmApiErrorRetriesRef.current = 0; // Reset retry counter on success

            // Disable eager approval check after first successful message (LET-7101)
            // Any new approvals from here on are from our own turn, not orphaned
            if (needsEagerApprovalCheck) {
              setNeedsEagerApprovalCheck(false);
            }

            // Send desktop notification when turn completes
            // and we're not about to auto-send another queued message
            if (!waitingForQueueCancelRef.current) {
              sendDesktopNotification();
            }

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

            // === RALPH WIGGUM CONTINUATION CHECK ===
            // Check if ralph mode is active and should auto-continue
            // This happens at the very end, right before we'd release input
            if (ralphMode.getState().isActive) {
              handleRalphContinuation();
              return;
            }

            return;
          }

          // Case 1.5: Stream was cancelled by user
          if (stopReasonToHandle === "cancelled") {
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
                appendError(INTERRUPT_MESSAGE, true);
              }

              // In ralph mode, ESC interrupts but does NOT exit ralph
              // User can type additional instructions, which will get ralph prefix prepended
              // (Similar to how plan mode works)
              if (ralphMode.getState().isActive) {
                // Add status to transcript showing ralph is paused
                const statusId = uid("status");
                buffersRef.current.byId.set(statusId, {
                  kind: "status",
                  id: statusId,
                  lines: [
                    `⏸️ Ralph loop paused - type to continue or shift+tab to exit`,
                  ],
                });
                buffersRef.current.order.push(statusId);
                refreshDerived();
              }
            }

            return;
          }

          // Case 2: Requires approval
          if (stopReasonToHandle === "requires_approval") {
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

            // Check if user cancelled before starting permission checks
            if (
              userCancelledRef.current ||
              abortControllerRef.current?.signal.aborted
            ) {
              setStreaming(false);
              markIncompleteToolsAsCancelled(buffersRef.current);
              refreshDerived();
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

              // Some tools always need user input regardless of yolo mode
              if (
                alwaysRequiresUserInput(approval.toolName) &&
                decision === "allow"
              ) {
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

            // Precompute diffs for file edit tools before execution (both auto-allowed and needs-user-input)
            // This is needed for inline approval UI to show diffs, and for post-approval rendering
            for (const ac of [...autoAllowed, ...needsUserInput]) {
              const toolName = ac.approval.toolName;
              const toolCallId = ac.approval.toolCallId;
              try {
                const args = JSON.parse(ac.approval.toolArgs || "{}");

                if (isFileWriteTool(toolName)) {
                  const filePath = args.file_path as string | undefined;
                  if (filePath) {
                    const result = computeAdvancedDiff({
                      kind: "write",
                      filePath,
                      content: (args.content as string) || "",
                    });
                    if (result.mode === "advanced") {
                      precomputedDiffsRef.current.set(toolCallId, result);
                    }
                  }
                } else if (isFileEditTool(toolName)) {
                  const filePath = args.file_path as string | undefined;
                  if (filePath) {
                    // Check if it's a multi-edit (has edits array) or single edit
                    if (args.edits && Array.isArray(args.edits)) {
                      const result = computeAdvancedDiff({
                        kind: "multi_edit",
                        filePath,
                        edits: args.edits as Array<{
                          old_string: string;
                          new_string: string;
                          replace_all?: boolean;
                        }>,
                      });
                      if (result.mode === "advanced") {
                        precomputedDiffsRef.current.set(toolCallId, result);
                      }
                    } else {
                      const result = computeAdvancedDiff({
                        kind: "edit",
                        filePath,
                        oldString: (args.old_string as string) || "",
                        newString: (args.new_string as string) || "",
                        replaceAll: args.replace_all as boolean | undefined,
                      });
                      if (result.mode === "advanced") {
                        precomputedDiffsRef.current.set(toolCallId, result);
                      }
                    }
                  }
                } else if (isPatchTool(toolName) && args.input) {
                  // Patch tools - parse hunks directly (patches ARE diffs)
                  const operations = parsePatchOperations(args.input as string);
                  for (const op of operations) {
                    const key = `${toolCallId}:${op.path}`;
                    if (op.kind === "add" || op.kind === "update") {
                      const result = parsePatchToAdvancedDiff(
                        op.patchLines,
                        op.path,
                      );
                      if (result) {
                        precomputedDiffsRef.current.set(key, result);
                      }
                    }
                    // Delete operations don't need diffs
                  }
                }
              } catch {
                // Ignore errors in diff computation for auto-allowed tools
              }
            }

            // Set phase to "running" for auto-allowed tools
            setToolCallsRunning(
              buffersRef.current,
              autoAllowed.map((ac) => ac.approval.toolCallId),
            );
            refreshDerived();

            // Execute auto-allowed tools (sequential for writes, parallel for reads)
            const autoAllowedResults = await executeAutoAllowedTools(
              autoAllowed,
              (chunk) => onChunk(buffersRef.current, chunk),
              {
                abortSignal: signal,
                onStreamingOutput: updateStreamingOutput,
              },
            );

            // Create denial results for auto-denied tools and update buffers
            const autoDeniedResults = autoDenied.map((ac) => {
              // Prefer the detailed reason over the short matchedRule name
              // (e.g., reason contains plan file path info, matchedRule is just "plan mode")
              const reason = ac.permission.reason
                ? `Permission denied: ${ac.permission.reason}`
                : "matchedRule" in ac.permission && ac.permission.matchedRule
                  ? `Permission denied by rule: ${ac.permission.matchedRule}`
                  : "Permission denied: Unknown reason";

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
              setThinkingMessage(getRandomThinkingVerb());
              refreshDerived();

              await processConversation(
                [
                  {
                    type: "approval",
                    approvals: allResults,
                  },
                ],
                { allowReentry: true },
              );
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

            // Check if user cancelled before showing dialog
            if (
              userCancelledRef.current ||
              abortControllerRef.current?.signal.aborted
            ) {
              setStreaming(false);
              markIncompleteToolsAsCancelled(buffersRef.current);
              refreshDerived();
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
            // Notify user that approval is needed
            sendDesktopNotification();
            return;
          }

          // Unexpected stop reason (error, llm_api_error, etc.)
          // Cache desync detection and last failure for consistent handling
          // Check if payload contains approvals (could be approval-only or mixed with user message)
          const hasApprovalInPayload = currentInput.some(
            (item) => item?.type === "approval",
          );
          const isApprovalOnlyPayload =
            hasApprovalInPayload && currentInput.length === 1;

          // Capture the most recent error text in this turn (if any)
          let latestErrorText: string | null = null;
          for (let i = buffersRef.current.order.length - 1; i >= 0; i -= 1) {
            const id = buffersRef.current.order[i];
            if (!id) continue;
            const entry = buffersRef.current.byId.get(id);
            if (entry?.kind === "error" && typeof entry.text === "string") {
              latestErrorText = entry.text;
              break;
            }
          }

          // Detect approval desync once per turn
          const detailFromRun = await fetchRunErrorDetail(lastRunId);
          const desyncDetected =
            isApprovalStateDesyncError(detailFromRun) ||
            isApprovalStateDesyncError(latestErrorText);

          // Track last failure info so we can emit it if retries stop
          const lastFailureMessage = latestErrorText || detailFromRun || null;

          // Check for approval desync errors even if stop_reason isn't llm_api_error.
          // Handle both approval-only payloads and mixed [approval, message] payloads.
          if (hasApprovalInPayload && desyncDetected) {
            if (llmApiErrorRetriesRef.current < LLM_API_ERROR_MAX_RETRIES) {
              llmApiErrorRetriesRef.current += 1;
              const statusId = uid("status");
              buffersRef.current.byId.set(statusId, {
                kind: "status",
                id: statusId,
                lines: [
                  "Approval state desynced; resending keep-alive recovery prompt...",
                ],
              });
              buffersRef.current.order.push(statusId);
              refreshDerived();

              if (isApprovalOnlyPayload) {
                // Approval-only payload: send recovery prompt
                currentInput.splice(
                  0,
                  currentInput.length,
                  buildApprovalRecoveryMessage(),
                );
              } else {
                // Mixed payload [approval, message]: strip stale approval, keep user message
                const messageItems = currentInput.filter(
                  (item) => item?.type !== "approval",
                );
                if (messageItems.length > 0) {
                  currentInput.splice(0, currentInput.length, ...messageItems);
                } else {
                  // Fallback if somehow no message items remain
                  currentInput.splice(
                    0,
                    currentInput.length,
                    buildApprovalRecoveryMessage(),
                  );
                }
              }

              // Remove the transient status before retrying
              buffersRef.current.byId.delete(statusId);
              buffersRef.current.order = buffersRef.current.order.filter(
                (id) => id !== statusId,
              );
              refreshDerived();

              // Reset interrupted flag so retry stream chunks are processed
              buffersRef.current.interrupted = false;
              continue;
            }

            // No retries left: emit the failure and exit
            const errorToShow =
              lastFailureMessage ||
              `An error occurred during agent execution\n(run_id: ${lastRunId ?? "unknown"}, stop_reason: ${stopReasonToHandle})`;
            appendError(errorToShow, true);
            setStreaming(false);
            sendDesktopNotification();
            refreshDerived();
            return;
          }

          // Check for approval pending error (sent user message while approval waiting)
          // This is the lazy recovery path for when needsEagerApprovalCheck is false
          const approvalPendingDetected =
            isApprovalPendingError(detailFromRun) ||
            isApprovalPendingError(latestErrorText);

          if (
            !hasApprovalInPayload &&
            approvalPendingDetected &&
            llmApiErrorRetriesRef.current < LLM_API_ERROR_MAX_RETRIES
          ) {
            llmApiErrorRetriesRef.current += 1;

            // Log for debugging (visible in transcripts)
            const statusId = uid("status");
            buffersRef.current.byId.set(statusId, {
              kind: "status",
              id: statusId,
              lines: [
                "[LAZY RECOVERY] Detected CONFLICT: server has pending approval",
                "[LAZY RECOVERY] Fetching stale approvals to auto-deny...",
              ],
            });
            buffersRef.current.order.push(statusId);
            refreshDerived();

            try {
              // Fetch pending approvals and auto-deny them
              const client = await getClient();
              const agent = await client.agents.retrieve(agentIdRef.current);
              const { pendingApprovals: existingApprovals } =
                await getResumeData(client, agent, conversationIdRef.current);

              if (existingApprovals && existingApprovals.length > 0) {
                // Update status with details
                buffersRef.current.byId.set(statusId, {
                  kind: "status",
                  id: statusId,
                  lines: [
                    "[LAZY RECOVERY] Detected CONFLICT: server has pending approval",
                    `[LAZY RECOVERY] Found ${existingApprovals.length} stale approval(s):`,
                    ...existingApprovals.map(
                      (a) =>
                        `  - ${a.toolName} (${a.toolCallId.slice(0, 8)}...)`,
                    ),
                    "[LAZY RECOVERY] Auto-denying and batching with user message...",
                  ],
                });
                refreshDerived();

                // Create denial results for all stale approvals
                // Use the same format as handleCancelApprovals (lines 6390-6395)
                const denialResults = existingApprovals.map((approval) => ({
                  type: "approval" as const,
                  tool_call_id: approval.toolCallId,
                  approve: false,
                  reason:
                    "Auto-denied: stale approval from interrupted session",
                }));

                // Prepend approval denials to the current input (keeps user message)
                const approvalPayload: ApprovalCreate = {
                  type: "approval",
                  approvals: denialResults,
                };
                currentInput.unshift(approvalPayload);
              } else {
                // No approvals found - server state may have cleared
                buffersRef.current.byId.set(statusId, {
                  kind: "status",
                  id: statusId,
                  lines: [
                    "[LAZY RECOVERY] Detected CONFLICT but no pending approvals found",
                    "[LAZY RECOVERY] Retrying message...",
                  ],
                });
                refreshDerived();
              }
            } catch (_recoveryError) {
              // If we can't fetch approvals, just retry the original message
              buffersRef.current.byId.set(statusId, {
                kind: "status",
                id: statusId,
                lines: [
                  "[LAZY RECOVERY] Failed to fetch pending approvals",
                  "[LAZY RECOVERY] Retrying message anyway...",
                ],
              });
              refreshDerived();
            }

            // Brief pause so user can see the status
            await new Promise((resolve) => setTimeout(resolve, 500));

            // Remove the transient status
            buffersRef.current.byId.delete(statusId);
            buffersRef.current.order = buffersRef.current.order.filter(
              (id) => id !== statusId,
            );
            refreshDerived();

            // Reset interrupted flag so retry stream chunks are processed
            buffersRef.current.interrupted = false;
            continue;
          }

          // Check if this is a retriable error (transient LLM API error)
          const retriable = await isRetriableError(
            stopReasonToHandle,
            lastRunId,
          );

          if (
            retriable &&
            llmApiErrorRetriesRef.current < LLM_API_ERROR_MAX_RETRIES
          ) {
            llmApiErrorRetriesRef.current += 1;
            const attempt = llmApiErrorRetriesRef.current;
            const delayMs = 1000 * 2 ** (attempt - 1); // 1s, 2s, 4s

            // Show subtle grey status message
            const statusId = uid("status");
            const statusLines = [
              "Unexpected downstream LLM API error, retrying...",
            ];
            buffersRef.current.byId.set(statusId, {
              kind: "status",
              id: statusId,
              lines: statusLines,
            });
            buffersRef.current.order.push(statusId);
            refreshDerived();

            // Wait before retry (check abort signal periodically for ESC cancellation)
            let cancelled = false;
            const startTime = Date.now();
            while (Date.now() - startTime < delayMs) {
              if (
                abortControllerRef.current?.signal.aborted ||
                userCancelledRef.current
              ) {
                cancelled = true;
                break;
              }
              await new Promise((resolve) => setTimeout(resolve, 100)); // Check every 100ms
            }

            // Remove status message
            buffersRef.current.byId.delete(statusId);
            buffersRef.current.order = buffersRef.current.order.filter(
              (id) => id !== statusId,
            );
            refreshDerived();

            if (!cancelled) {
              // Reset interrupted flag so retry stream chunks are processed
              buffersRef.current.interrupted = false;
              // Retry by continuing the while loop (same currentInput)
              continue;
            }
            // User pressed ESC - fall through to error handling
          }

          // Reset retry counter on non-retriable error (or max retries exceeded)
          llmApiErrorRetriesRef.current = 0;

          // Mark incomplete tool calls as finished to prevent stuck blinking UI
          markIncompleteToolsAsCancelled(buffersRef.current);

          // Track the error in telemetry
          telemetry.trackError(
            fallbackError
              ? "FallbackError"
              : stopReasonToHandle || "unknown_stop_reason",
            fallbackError ||
              `Stream stopped with reason: ${stopReasonToHandle}`,
            "message_stream",
            {
              modelId: currentModelId || undefined,
              runId: lastRunId ?? undefined,
            },
          );

          // If we have a client-side stream error (e.g., JSON parse error), show it directly
          // Fallback error: no run_id available, show whatever error message we have
          if (fallbackError) {
            const errorMsg = lastRunId
              ? `Stream error: ${fallbackError}\n(run_id: ${lastRunId})`
              : `Stream error: ${fallbackError}`;
            appendError(errorMsg, true); // Skip telemetry - already tracked above
            setStreaming(false);
            sendDesktopNotification(); // Notify user of error
            refreshDerived();
            return;
          }

          // Fetch error details from the run if available (server-side errors)
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
                appendError(errorDetails, true); // Skip telemetry - already tracked above
              } else {
                // No error metadata, show generic error with run info
                appendError(
                  `An error occurred during agent execution\n(run_id: ${lastRunId}, stop_reason: ${stopReason})`,
                  true, // Skip telemetry - already tracked above
                );
              }
            } catch (_e) {
              // If we can't fetch error details, show generic error
              appendError(
                `An error occurred during agent execution\n(run_id: ${lastRunId}, stop_reason: ${stopReason})\n(Unable to fetch additional error details from server)`,
                true, // Skip telemetry - already tracked above
              );
              return;
            }
          } else {
            // No run_id available - but this is unusual since errors should have run_ids
            appendError(
              `An error occurred during agent execution\n(stop_reason: ${stopReason})`,
              true, // Skip telemetry - already tracked above
            );
          }

          setStreaming(false);
          sendDesktopNotification(); // Notify user of error
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

        // Track error with enhanced context
        const errorType =
          e instanceof Error ? e.constructor.name : "UnknownError";
        const errorMessage = e instanceof Error ? e.message : String(e);

        // Extract HTTP status code if available (API errors often have this)
        const httpStatus =
          e &&
          typeof e === "object" &&
          "status" in e &&
          typeof e.status === "number"
            ? e.status
            : undefined;

        telemetry.trackError(errorType, errorMessage, "message_stream", {
          httpStatus,
          modelId: currentModelId || undefined,
          runId: currentRunId,
        });

        // Use comprehensive error formatting
        const errorDetails = formatErrorDetails(e, agentIdRef.current);
        appendError(errorDetails, true); // Skip telemetry - already tracked above with more context
        setStreaming(false);
        sendDesktopNotification(); // Notify user of error
        refreshDerived();
      } finally {
        // Check if this conversation was superseded by an ESC interrupt
        const isStale = myGeneration !== conversationGenerationRef.current;

        abortControllerRef.current = null;

        // Only decrement ref if this conversation is still current.
        // If stale (ESC was pressed), handleInterrupt already reset ref to 0.
        if (!isStale) {
          processingConversationRef.current = Math.max(
            0,
            processingConversationRef.current - 1,
          );
        }
      }
    },
    [
      appendError,
      refreshDerived,
      refreshDerivedThrottled,
      setStreaming,
      currentModelId,
      updateStreamingOutput,
      needsEagerApprovalCheck,
    ],
  );

  const handleExit = useCallback(async () => {
    saveLastAgentBeforeExit();

    // Track session end explicitly (before exit) with stats
    const stats = sessionStatsRef.current.getSnapshot();
    telemetry.trackSessionEnd(stats, "exit_command");

    // Flush telemetry before exit
    await telemetry.flush();

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
    // If we're executing client-side tools, abort them AND the main stream
    if (isExecutingTool && toolAbortControllerRef.current) {
      toolAbortControllerRef.current.abort();

      if (executingToolCallIdsRef.current.length > 0) {
        const interruptedResults = executingToolCallIdsRef.current.map(
          (toolCallId) => ({
            type: "tool" as const,
            tool_call_id: toolCallId,
            tool_return: INTERRUPTED_BY_USER,
            status: "error" as const,
          }),
        );
        setQueuedApprovalResults(interruptedResults);
        executingToolCallIdsRef.current = [];
        interruptQueuedRef.current = true;
      }

      // ALSO abort the main stream - don't leave it running
      buffersRef.current.abortGeneration =
        (buffersRef.current.abortGeneration || 0) + 1;
      const toolsCancelled = markIncompleteToolsAsCancelled(buffersRef.current);

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

      userCancelledRef.current = true; // Prevent dequeue
      setStreaming(false);
      setIsExecutingTool(false);
      refreshDerived();

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
      const toolsCancelled = markIncompleteToolsAsCancelled(buffersRef.current);

      // Mark any running subagents as interrupted
      interruptActiveSubagents(INTERRUPTED_BY_USER);

      // NOW abort the stream - interrupted flag is already set
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null; // Clear ref so isAgentBusy() returns false
      }

      // Set cancellation flag to prevent processConversation from starting
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
      if (!toolsCancelled) {
        appendError(INTERRUPT_MESSAGE, true);
      }
      refreshDerived();

      // Cache any pending approvals as denials to send with the next message
      // This tells the server "I'm rejecting these approvals" so it doesn't stay stuck waiting
      if (pendingApprovals.length > 0) {
        const denialResults = pendingApprovals.map((approval) => ({
          type: "approval" as const,
          tool_call_id: approval.toolCallId,
          approve: false,
          reason: "User interrupted the stream",
        }));
        setQueuedApprovalResults(denialResults);
      }

      // Clear local approval state
      setPendingApprovals([]);
      setApprovalContexts([]);
      setApprovalResults([]);
      setAutoHandledResults([]);
      setAutoDeniedApprovals([]);

      // Send cancel request to backend asynchronously (fire-and-forget)
      // Don't wait for it or show errors since user already got feedback
      getClient()
        .then((client) =>
          client.conversations.cancel(conversationIdRef.current),
        )
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
        const client = await getClient();
        await client.conversations.cancel(conversationIdRef.current);

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
    setStreaming,
    pendingApprovals,
  ]);

  // Keep ref to latest processConversation to avoid circular deps in useEffect
  const processConversationRef = useRef(processConversation);
  useEffect(() => {
    processConversationRef.current = processConversation;
  }, [processConversation]);

  const handleAgentSelect = useCallback(
    async (targetAgentId: string, _opts?: { profileName?: string }) => {
      // Close selector immediately
      setActiveOverlay(null);

      // Skip if already on this agent (no async work needed, queue can proceed)
      if (targetAgentId === agentId) {
        const label = agentName || targetAgentId.slice(0, 12);
        const cmdId = uid("cmd");
        buffersRef.current.byId.set(cmdId, {
          kind: "command",
          id: cmdId,
          input: "/agents",
          output: `Already on "${label}"`,
          phase: "finished",
          success: true,
        });
        buffersRef.current.order.push(cmdId);
        refreshDerived();
        return;
      }

      // Lock input for async operation (set before any await to prevent queue processing)
      setCommandRunning(true);

      const inputCmd = "/agents";
      const cmdId = uid("cmd");

      // Show loading indicator while switching
      buffersRef.current.byId.set(cmdId, {
        kind: "command",
        id: cmdId,
        input: inputCmd,
        output: "Switching agent...",
        phase: "running",
      });
      buffersRef.current.order.push(cmdId);
      refreshDerived();

      try {
        const client = await getClient();
        // Fetch new agent
        const agent = await client.agents.retrieve(targetAgentId);

        // Always create a new conversation when switching agents
        // User can /resume to get back to a previous conversation if needed
        const newConversation = await client.conversations.create({
          agent_id: targetAgentId,
          isolated_block_labels: [...ISOLATED_BLOCK_LABELS],
        });
        const targetConversationId = newConversation.id;

        // Update project settings with new agent
        await updateProjectSettings({ lastAgent: targetAgentId });

        // Save the session (agent + conversation) to settings
        settingsManager.setLocalLastSession(
          { agentId: targetAgentId, conversationId: targetConversationId },
          process.cwd(),
        );
        settingsManager.setGlobalLastSession({
          agentId: targetAgentId,
          conversationId: targetConversationId,
        });

        // Clear current transcript and static items
        buffersRef.current.byId.clear();
        buffersRef.current.order = [];
        buffersRef.current.tokenCount = 0;
        emittedIdsRef.current.clear();
        setStaticItems([]);
        setStaticRenderEpoch((e) => e + 1);

        // Reset turn counter for memory reminders when switching agents
        turnCountRef.current = 0;

        // Update agent state - also update ref immediately for any code that runs before re-render
        agentIdRef.current = targetAgentId;
        setAgentId(targetAgentId);
        setAgentState(agent);
        setAgentName(agent.name);
        setLlmConfig(agent.llm_config);
        setConversationId(targetConversationId);

        // Build success message - always a new conversation
        const agentLabel = agent.name || targetAgentId;
        const successOutput = [
          `Started a new conversation with **${agentLabel}**.`,
          `⎿  Type /resume to resume a previous conversation`,
        ].join("\n");
        const successItem: StaticItem = {
          kind: "command",
          id: uid("cmd"),
          input: inputCmd,
          output: successOutput,
          phase: "finished",
          success: true,
        };

        // Add separator for visual spacing, then success message
        const separator = {
          kind: "separator" as const,
          id: uid("sep"),
        };
        setStaticItems([separator, successItem]);
        setLines(toLines(buffersRef.current));
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
    [refreshDerived, agentId, agentName, setCommandRunning],
  );

  // Handle creating a new agent and switching to it
  const handleCreateNewAgent = useCallback(
    async (name: string) => {
      // Close dialog immediately
      setActiveOverlay(null);

      // Lock input for async operation
      setCommandRunning(true);

      const inputCmd = "/new";
      const cmdId = uid("cmd");

      // Show "Creating..." status while we wait
      buffersRef.current.byId.set(cmdId, {
        kind: "command",
        id: cmdId,
        input: inputCmd,
        output: `Creating agent "${name}"...`,
        phase: "running",
      });
      buffersRef.current.order.push(cmdId);
      refreshDerived();

      try {
        // Create the new agent
        const { agent } = await createAgent(name);

        // Update project settings with new agent
        await updateProjectSettings({ lastAgent: agent.id });

        // Clear current transcript and static items
        buffersRef.current.byId.clear();
        buffersRef.current.order = [];
        buffersRef.current.tokenCount = 0;
        emittedIdsRef.current.clear();
        setStaticItems([]);
        setStaticRenderEpoch((e) => e + 1);

        // Reset turn counter for memory reminders
        turnCountRef.current = 0;

        // Update agent state
        agentIdRef.current = agent.id;
        setAgentId(agent.id);
        setAgentState(agent);
        setAgentName(agent.name);
        setLlmConfig(agent.llm_config);

        // Build success message with hints
        const agentUrl = `https://app.letta.com/projects/default-project/agents/${agent.id}`;
        const successOutput = [
          `Created **${agent.name || agent.id}** (use /pin to save)`,
          `⎿  ${agentUrl}`,
          `⎿  Tip: use /init to initialize your agent's memory system!`,
        ].join("\n");

        const separator = {
          kind: "separator" as const,
          id: uid("sep"),
        };
        const successItem: StaticItem = {
          kind: "command",
          id: uid("cmd"),
          input: inputCmd,
          output: successOutput,
          phase: "finished",
          success: true,
        };

        setStaticItems([separator, successItem]);
        // Sync lines display after clearing buffers
        setLines(toLines(buffersRef.current));
      } catch (error) {
        const errorDetails = formatErrorDetails(error, agentId);
        buffersRef.current.byId.set(cmdId, {
          kind: "command",
          id: cmdId,
          input: inputCmd,
          output: `Failed to create agent: ${errorDetails}`,
          phase: "finished",
          success: false,
        });
        refreshDerived();
      } finally {
        setCommandRunning(false);
      }
    },
    [refreshDerived, agentId, setCommandRunning],
  );

  // Handle bash mode command submission
  // Uses the same shell runner as the Bash tool for consistency
  const handleBashSubmit = useCallback(
    async (command: string) => {
      const cmdId = uid("bash");
      const startTime = Date.now();

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
        // Use the same spawnCommand as the Bash tool for consistent behavior
        const { spawnCommand } = await import("../tools/impl/Bash.js");
        const { getShellEnv } = await import("../tools/impl/shellEnv.js");

        const result = await spawnCommand(command, {
          cwd: process.cwd(),
          env: getShellEnv(),
          timeout: 30000, // 30 second timeout
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
        buffersRef.current.byId.set(cmdId, {
          kind: "bash_command",
          id: cmdId,
          input: command,
          output: output || (success ? "" : `Exit code: ${result.exitCode}`),
          phase: "finished",
          success,
          streaming: undefined,
        });

        // Cache for next user message
        bashCommandCacheRef.current.push({
          input: command,
          output: output || (success ? "" : `Exit code: ${result.exitCode}`),
        });
      } catch (error: unknown) {
        // Handle command errors (timeout, abort, etc.)
        const errOutput =
          error instanceof Error
            ? (error as { stderr?: string; stdout?: string }).stderr ||
              (error as { stdout?: string }).stdout ||
              error.message
            : String(error);

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
      }

      refreshDerived();
    },
    [refreshDerived, refreshDerivedStreaming],
  );

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

    try {
      const client = await getClient();
      const agent = await client.agents.retrieve(agentId);
      const { pendingApprovals: existingApprovals } = await getResumeData(
        client,
        agent,
        conversationIdRef.current,
      );

      if (!existingApprovals || existingApprovals.length === 0) {
        return { blocked: false };
      }

      // There are pending approvals - check permissions (respects yolo mode)
      const approvalResults = await Promise.all(
        existingApprovals.map(async (approvalItem) => {
          if (!approvalItem.toolName) {
            return {
              approval: approvalItem,
              permission: {
                decision: "deny" as const,
                reason: "Tool call incomplete - missing name",
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

      // Categorize by permission decision
      const needsUserInput: typeof approvalResults = [];
      const autoAllowed: typeof approvalResults = [];
      const autoDenied: typeof approvalResults = [];

      for (const ac of approvalResults) {
        const { approval, permission } = ac;
        let decision = permission.decision;

        if (
          alwaysRequiresUserInput(approval.toolName) &&
          decision === "allow"
        ) {
          decision = "ask";
        }

        if (decision === "ask") {
          needsUserInput.push(ac);
        } else if (decision === "deny") {
          autoDenied.push(ac);
        } else {
          autoAllowed.push(ac);
        }
      }

      // If any approvals need user input, show dialog
      if (needsUserInput.length > 0) {
        setPendingApprovals(needsUserInput.map((ac) => ac.approval));
        setApprovalContexts(
          needsUserInput
            .map((ac) => ac.context)
            .filter((ctx): ctx is ApprovalContext => ctx !== null),
        );
        return { blocked: true };
      }

      // All approvals can be auto-handled - execute them before proceeding
      const allResults: ApprovalResult[] = [];

      // Execute auto-allowed tools
      if (autoAllowed.length > 0) {
        // Set phase to "running" for auto-allowed tools
        setToolCallsRunning(
          buffersRef.current,
          autoAllowed.map((ac) => ac.approval.toolCallId),
        );
        refreshDerived();

        const autoAllowedResults = await executeAutoAllowedTools(
          autoAllowed,
          (chunk) => onChunk(buffersRef.current, chunk),
          { onStreamingOutput: updateStreamingOutput },
        );
        // Map to ApprovalResult format (ToolReturn)
        allResults.push(
          ...autoAllowedResults.map((ar) => ({
            type: "tool" as const,
            tool_call_id: ar.toolCallId,
            tool_return: ar.result.toolReturn,
            status: ar.result.status,
            stdout: ar.result.stdout,
            stderr: ar.result.stderr,
          })),
        );
      }

      // Create denial results for auto-denied
      for (const ac of autoDenied) {
        const reason = ac.permission.reason || "Permission denied";
        // Update UI with denial
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
        // Map to ApprovalResult format (ApprovalReturn)
        allResults.push({
          type: "approval" as const,
          tool_call_id: ac.approval.toolCallId,
          approve: false,
          reason,
        });
      }

      // Send all results to server if any
      if (allResults.length > 0) {
        await processConversation([
          { type: "approval", approvals: allResults },
        ]);
      }

      return { blocked: false };
    } catch {
      // If check fails, proceed anyway (don't block user)
      return { blocked: false };
    }
  }, [
    agentId,
    processConversation,
    refreshDerived,
    updateStreamingOutput,
    needsEagerApprovalCheck,
  ]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refs read .current dynamically, complex callback with intentional deps
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

      // Capture the generation at submission time, BEFORE any async work.
      // This allows detecting if ESC was pressed during async operations.
      const submissionGeneration = conversationGenerationRef.current;

      // Track user input (agent_id automatically added from telemetry.currentAgentId)
      telemetry.trackUserInput(msg, "user", currentModelId || "unknown");

      // Block submission if waiting for explicit user action (approvals)
      // In this case, input is hidden anyway, so this shouldn't happen
      if (pendingApprovals.length > 0) {
        return { submitted: false };
      }

      // Queue message if agent is busy (streaming, executing tool, or running command)
      // This allows messages to queue up while agent is working

      // Reset cancellation flag before queue check - this ensures queued messages
      // can be dequeued even if the user just cancelled. The dequeue effect checks
      // userCancelledRef.current, so we must clear it here to prevent blocking.
      userCancelledRef.current = false;

      if (isAgentBusy()) {
        setMessageQueue((prev) => {
          const newQueue = [...prev, msg];

          // For slash commands, just queue and wait - don't interrupt the agent.
          // For regular messages, cancel the stream so the new message can be sent.
          const isSlashCommand = msg.startsWith("/");

          if (
            !isSlashCommand &&
            streamingRef.current &&
            !waitingForQueueCancelRef.current
          ) {
            waitingForQueueCancelRef.current = true;
            queueSnapshotRef.current = [...newQueue];

            // Abort client-side tool execution if in progress
            // This makes tool interruption visible immediately instead of waiting for completion
            if (toolAbortControllerRef.current) {
              toolAbortControllerRef.current.abort();
            }

            // Send cancel request to backend (fire-and-forget)
            getClient()
              .then((client) =>
                client.conversations.cancel(conversationIdRef.current),
              )
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

      // Note: userCancelledRef.current was already reset above before the queue check
      // to ensure the dequeue effect isn't blocked by a stale cancellation flag.

      // Handle pending Ralph config - activate ralph mode but let message flow through normal path
      // This ensures session context and other reminders are included
      // Track if we just activated so we can use first turn reminder vs continuation
      let justActivatedRalph = false;
      if (pendingRalphConfig && !msg.startsWith("/")) {
        const { completionPromise, maxIterations, isYolo } = pendingRalphConfig;
        ralphMode.activate(msg, completionPromise, maxIterations, isYolo);
        setUiRalphActive(true);
        setPendingRalphConfig(null);
        justActivatedRalph = true;
        if (isYolo) {
          permissionMode.setMode("bypassPermissions");
        }

        const ralphState = ralphMode.getState();

        // Add status to transcript
        const statusId = uid("status");
        const promiseDisplay = ralphState.completionPromise
          ? `"${ralphState.completionPromise.slice(0, 50)}${ralphState.completionPromise.length > 50 ? "..." : ""}"`
          : "(none)";
        buffersRef.current.byId.set(statusId, {
          kind: "status",
          id: statusId,
          lines: [
            `🔄 ${isYolo ? "yolo-ralph" : "ralph"} mode started (iter 1/${maxIterations || "∞"})`,
            `Promise: ${promiseDisplay}`,
          ],
        });
        buffersRef.current.order.push(statusId);
        refreshDerived();

        // Don't return - let message flow through normal path which will:
        // 1. Add session context reminder (if first message)
        // 2. Add ralph mode reminder (since ralph is now active)
        // 3. Add other reminders (skill unload, memory, etc.)
      }

      let aliasedMsg = msg;
      if (msg === "exit" || msg === "quit") {
        aliasedMsg = "/exit";
      }

      // Handle commands (messages starting with "/")
      if (aliasedMsg.startsWith("/")) {
        const trimmed = aliasedMsg.trim();

        // Special handling for /model command - opens selector
        if (trimmed === "/model") {
          setModelSelectorOptions({}); // Clear any filters from previous connection
          setActiveOverlay("model");
          return { submitted: true };
        }

        // Special handling for /toolset command - opens selector
        if (trimmed === "/toolset") {
          setActiveOverlay("toolset");
          return { submitted: true };
        }

        // Special handling for /ade command - open agent in browser
        if (trimmed === "/ade") {
          const adeUrl = `https://app.letta.com/agents/${agentId}?conversation=${conversationIdRef.current}`;
          const cmdId = uid("cmd");

          // Fire-and-forget browser open
          import("open")
            .then(({ default: open }) => open(adeUrl, { wait: false }))
            .catch(() => {
              // Silently ignore - user can use the URL from the output
            });

          // Always show the URL in case browser doesn't open
          buffersRef.current.byId.set(cmdId, {
            kind: "command",
            id: cmdId,
            input: "/ade",
            output: `Opening ADE...\n→ ${adeUrl}`,
            phase: "finished",
            success: true,
          });
          buffersRef.current.order.push(cmdId);
          refreshDerived();
          return { submitted: true };
        }

        // Special handling for /system command - opens system prompt selector
        if (trimmed === "/system") {
          setActiveOverlay("system");
          return { submitted: true };
        }

        // Special handling for /subagents command - opens subagent manager
        if (trimmed === "/subagents") {
          setActiveOverlay("subagent");
          return { submitted: true };
        }

        // Special handling for /memory command - opens memory viewer
        if (trimmed === "/memory") {
          setActiveOverlay("memory");
          return { submitted: true };
        }

        // Special handling for /mcp command - manage MCP servers
        if (msg.trim().startsWith("/mcp")) {
          const mcpCtx: McpCommandContext = {
            buffersRef,
            refreshDerived,
            setCommandRunning,
          };

          // Check for subcommand by looking at the first word after /mcp
          const afterMcp = msg.trim().slice(4).trim(); // Remove "/mcp" prefix
          const firstWord = afterMcp.split(/\s+/)[0]?.toLowerCase();

          // /mcp - open MCP server selector
          if (!firstWord) {
            setActiveOverlay("mcp");
            return { submitted: true };
          }

          // /mcp add --transport <type> <name> <url/command> [options]
          if (firstWord === "add") {
            // Pass the full command string after "add" to preserve quotes
            const afterAdd = afterMcp.slice(firstWord.length).trim();
            await handleMcpAdd(mcpCtx, msg, afterAdd);
            return { submitted: true };
          }

          // /mcp connect - interactive TUI for connecting with OAuth
          if (firstWord === "connect") {
            setActiveOverlay("mcp-connect");
            return { submitted: true };
          }

          // Unknown subcommand
          handleMcpUsage(mcpCtx, msg);
          return { submitted: true };
        }

        // Special handling for /connect command - OAuth connection
        if (msg.trim().startsWith("/connect")) {
          // Handle all /connect commands through the unified handler
          // For codex: uses local ChatGPT OAuth server (no dialog needed)
          // For zai: requires API key as argument
          const { handleConnect } = await import("./commands/connect");
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
                setActiveOverlay("model");
              },
            },
            msg,
          );
          return { submitted: true };
        }

        // Special handling for /disconnect command - remove OAuth connection
        if (msg.trim().startsWith("/disconnect")) {
          const { handleDisconnect } = await import("./commands/connect");
          await handleDisconnect(
            {
              buffersRef,
              refreshDerived,
              setCommandRunning,
            },
            msg,
          );
          return { submitted: true };
        }

        // Special handling for /help command - opens help dialog
        if (trimmed === "/help") {
          setActiveOverlay("help");
          return { submitted: true };
        }

        // Special handling for /usage command - show session stats
        if (trimmed === "/usage") {
          const cmdId = uid("cmd");
          buffersRef.current.byId.set(cmdId, {
            kind: "command",
            id: cmdId,
            input: trimmed,
            output: "Fetching usage statistics...",
            phase: "running",
          });
          buffersRef.current.order.push(cmdId);
          refreshDerived();

          // Fetch balance and display stats asynchronously
          (async () => {
            try {
              const stats = sessionStatsRef.current.getSnapshot();

              // Try to fetch balance info (only works for Letta Cloud)
              // Silently skip if endpoint not available (not deployed yet or self-hosted)
              let balance:
                | {
                    total_balance: number;
                    monthly_credit_balance: number;
                    purchased_credit_balance: number;
                    billing_tier: string;
                  }
                | undefined;

              try {
                const settings = settingsManager.getSettings();
                const baseURL =
                  process.env.LETTA_BASE_URL ||
                  settings.env?.LETTA_BASE_URL ||
                  "https://api.letta.com";
                const apiKey =
                  process.env.LETTA_API_KEY || settings.env?.LETTA_API_KEY;

                const balanceResponse = await fetch(
                  `${baseURL}/v1/metadata/balance`,
                  {
                    headers: {
                      "Content-Type": "application/json",
                      Authorization: `Bearer ${apiKey}`,
                      "X-Letta-Source": "letta-code",
                    },
                  },
                );

                if (balanceResponse.ok) {
                  balance = (await balanceResponse.json()) as {
                    total_balance: number;
                    monthly_credit_balance: number;
                    purchased_credit_balance: number;
                    billing_tier: string;
                  };
                }
              } catch {
                // Silently skip balance info if endpoint not available
              }

              const output = formatUsageStats({
                stats,
                balance,
              });

              buffersRef.current.byId.set(cmdId, {
                kind: "command",
                id: cmdId,
                input: trimmed,
                output,
                phase: "finished",
                success: true,
                dimOutput: true,
              });
              refreshDerived();
            } catch (error) {
              buffersRef.current.byId.set(cmdId, {
                kind: "command",
                id: cmdId,
                input: trimmed,
                output: `Error fetching usage: ${error instanceof Error ? error.message : String(error)}`,
                phase: "finished",
                success: false,
              });
              refreshDerived();
            }
          })();

          return { submitted: true };
        }

        // Special handling for /exit command - exit without stats
        if (trimmed === "/exit") {
          const cmdId = uid("cmd");
          buffersRef.current.byId.set(cmdId, {
            kind: "command",
            id: cmdId,
            input: trimmed,
            output: "See ya!",
            phase: "finished",
            success: true,
          });
          buffersRef.current.order.push(cmdId);
          refreshDerived();
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
            const currentSettings =
              await settingsManager.getSettingsWithSecureTokens();

            // Revoke refresh token on server if we have one
            if (currentSettings.refreshToken) {
              const { revokeToken } = await import("../auth/oauth");
              await revokeToken(currentSettings.refreshToken);
            }

            // Clear all credentials including secrets
            await settingsManager.logout();

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

            saveLastAgentBeforeExit();

            // Track session end explicitly (before exit) with stats
            const stats = sessionStatsRef.current.getSnapshot();
            telemetry.trackSessionEnd(stats, "logout");

            // Flush telemetry before exit
            await telemetry.flush();

            // Exit after a brief delay to show the message
            setTimeout(() => process.exit(0), 500);
          } catch (error) {
            let errorOutput = formatErrorDetails(error, agentId);

            // Add helpful tip for summarization failures
            if (errorOutput.includes("Summarization failed")) {
              errorOutput +=
                "\n\nTip: Use /clear instead to clear the current message buffer.";
            }

            buffersRef.current.byId.set(cmdId, {
              kind: "command",
              id: cmdId,
              input: msg,
              output: `Failed: ${errorOutput}`,
              phase: "finished",
              success: false,
            });
            refreshDerived();
          } finally {
            setCommandRunning(false);
          }
          return { submitted: true };
        }

        // Special handling for /ralph and /yolo-ralph commands - Ralph Wiggum mode
        if (trimmed.startsWith("/yolo-ralph") || trimmed.startsWith("/ralph")) {
          const isYolo = trimmed.startsWith("/yolo-ralph");
          const { prompt, completionPromise, maxIterations } =
            parseRalphArgs(trimmed);

          const cmdId = uid("cmd");

          if (prompt) {
            // Inline prompt - activate immediately and send
            ralphMode.activate(
              prompt,
              completionPromise,
              maxIterations,
              isYolo,
            );
            setUiRalphActive(true);
            if (isYolo) {
              permissionMode.setMode("bypassPermissions");
            }

            const ralphState = ralphMode.getState();
            const promiseDisplay = ralphState.completionPromise
              ? `"${ralphState.completionPromise.slice(0, 50)}${ralphState.completionPromise.length > 50 ? "..." : ""}"`
              : "(none)";

            buffersRef.current.byId.set(cmdId, {
              kind: "command",
              id: cmdId,
              input: trimmed,
              output: `🔄 ${isYolo ? "yolo-ralph" : "ralph"} mode activated (iter 1/${maxIterations || "∞"})\nPromise: ${promiseDisplay}`,
              phase: "finished",
              success: true,
            });
            buffersRef.current.order.push(cmdId);
            refreshDerived();

            // Send the prompt with ralph reminder prepended
            const systemMsg = buildRalphFirstTurnReminder(ralphState);
            processConversation([
              {
                type: "message",
                role: "user",
                content: `${systemMsg}\n\n${prompt}`,
              },
            ]);
          } else {
            // No inline prompt - wait for next message
            setPendingRalphConfig({ completionPromise, maxIterations, isYolo });

            const defaultPromisePreview = DEFAULT_COMPLETION_PROMISE.slice(
              0,
              40,
            );

            buffersRef.current.byId.set(cmdId, {
              kind: "command",
              id: cmdId,
              input: trimmed,
              output: `🔄 ${isYolo ? "yolo-ralph" : "ralph"} mode ready (waiting for task)\nMax iterations: ${maxIterations || "unlimited"}\nPromise: ${completionPromise === null ? "(none)" : (completionPromise ?? `"${defaultPromisePreview}..." (default)`)}\n\nType your task to begin the loop.`,
              phase: "finished",
              success: true,
            });
            buffersRef.current.order.push(cmdId);
            refreshDerived();
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

        // Special handling for /clear and /new commands - start new conversation
        // (/new used to create a new agent, now it's just an alias for /clear)
        if (msg.trim() === "/clear" || msg.trim() === "/new") {
          const cmdId = uid("cmd");
          buffersRef.current.byId.set(cmdId, {
            kind: "command",
            id: cmdId,
            input: msg,
            output: "Starting new conversation...",
            phase: "running",
          });
          buffersRef.current.order.push(cmdId);
          refreshDerived();

          setCommandRunning(true);

          try {
            const client = await getClient();

            // Create a new conversation for the current agent
            const conversation = await client.conversations.create({
              agent_id: agentId,
              isolated_block_labels: [...ISOLATED_BLOCK_LABELS],
            });

            // Update conversationId state
            setConversationId(conversation.id);

            // Save the new session to settings
            settingsManager.setLocalLastSession(
              { agentId, conversationId: conversation.id },
              process.cwd(),
            );
            settingsManager.setGlobalLastSession({
              agentId,
              conversationId: conversation.id,
            });

            // Reset turn counter for memory reminders
            turnCountRef.current = 0;

            // Update command with success
            buffersRef.current.byId.set(cmdId, {
              kind: "command",
              id: cmdId,
              input: msg,
              output: "Started new conversation",
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

        // Special handling for /clear-messages command - reset all agent messages (destructive)
        if (msg.trim() === "/clear-messages") {
          const cmdId = uid("cmd");
          buffersRef.current.byId.set(cmdId, {
            kind: "command",
            id: cmdId,
            input: msg,
            output: "Resetting agent messages...",
            phase: "running",
          });
          buffersRef.current.order.push(cmdId);
          refreshDerived();

          setCommandRunning(true);

          try {
            const client = await getClient();

            // Reset all messages on the agent (destructive operation)
            await client.agents.messages.reset(agentId, {
              add_default_initial_messages: false,
            });

            // Also create a new conversation since messages were cleared
            const conversation = await client.conversations.create({
              agent_id: agentId,
              isolated_block_labels: [...ISOLATED_BLOCK_LABELS],
            });
            setConversationId(conversation.id);
            settingsManager.setLocalLastSession(
              { agentId, conversationId: conversation.id },
              process.cwd(),
            );
            settingsManager.setGlobalLastSession({
              agentId,
              conversationId: conversation.id,
            });

            // Reset turn counter for memory reminders
            turnCountRef.current = 0;

            // Update command with success
            buffersRef.current.byId.set(cmdId, {
              kind: "command",
              id: cmdId,
              input: msg,
              output: "All agent messages reset",
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

        // Special handling for /compact command - summarize conversation history
        if (msg.trim() === "/compact") {
          const cmdId = uid("cmd");
          buffersRef.current.byId.set(cmdId, {
            kind: "command",
            id: cmdId,
            input: msg,
            output: "Compacting conversation history...",
            phase: "running",
          });
          buffersRef.current.order.push(cmdId);
          refreshDerived();

          setCommandRunning(true);

          try {
            const client = await getClient();
            // SDK types are out of date - compact returns CompactionResponse, not void
            const result = (await client.agents.messages.compact(
              agentId,
            )) as unknown as {
              num_messages_before: number;
              num_messages_after: number;
              summary: string;
            };

            // Format success message with before/after counts and summary
            const outputLines = [
              `Compaction completed. Message buffer length reduced from ${result.num_messages_before} to ${result.num_messages_after}.`,
              "",
              `Summary: ${result.summary}`,
            ];

            // Update command with success
            buffersRef.current.byId.set(cmdId, {
              kind: "command",
              id: cmdId,
              input: msg,
              output: outputLines.join("\n"),
              phase: "finished",
              success: true,
            });
            refreshDerived();
          } catch (error) {
            let errorOutput: string;

            // Check for summarization failure - format it cleanly
            const apiError = error as {
              status?: number;
              error?: { detail?: string };
            };
            const detail = apiError?.error?.detail;
            if (
              apiError?.status === 400 &&
              detail?.includes("Summarization failed")
            ) {
              // Clean format for this specific error, but preserve raw JSON
              const cleanDetail = detail.replace(/^\d{3}:\s*/, "");
              const rawJson = JSON.stringify(apiError.error);
              errorOutput = [
                `Request failed (code=400)`,
                `Raw: ${rawJson}`,
                `Detail: ${cleanDetail}`,
                "",
                "Tip: Use /clear instead to clear the current message buffer.",
              ].join("\n");
            } else {
              errorOutput = formatErrorDetails(error, agentId);
            }

            buffersRef.current.byId.set(cmdId, {
              kind: "command",
              id: cmdId,
              input: msg,
              output: `Failed: ${errorOutput}`,
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

          // Validate the name before sending to API
          const validationError = validateAgentName(newName);
          if (validationError) {
            const cmdId = uid("cmd");
            buffersRef.current.byId.set(cmdId, {
              kind: "command",
              id: cmdId,
              input: msg,
              output: validationError,
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

        // Special handling for /agents command - show agent browser
        // /pinned, /profiles are hidden aliases
        if (
          msg.trim() === "/agents" ||
          msg.trim() === "/pinned" ||
          msg.trim() === "/profiles"
        ) {
          setActiveOverlay("resume");
          return { submitted: true };
        }

        // Special handling for /resume command - show conversation selector or switch directly
        if (msg.trim().startsWith("/resume")) {
          const parts = msg.trim().split(/\s+/);
          const targetConvId = parts[1]; // Optional conversation ID

          if (targetConvId) {
            // Direct switch to specified conversation
            if (targetConvId === conversationId) {
              const cmdId = uid("cmd");
              buffersRef.current.byId.set(cmdId, {
                kind: "command",
                id: cmdId,
                input: msg.trim(),
                output: "Already on this conversation",
                phase: "finished",
                success: true,
              });
              buffersRef.current.order.push(cmdId);
              refreshDerived();
              return { submitted: true };
            }

            // Lock input and show loading
            setCommandRunning(true);
            const cmdId = uid("cmd");
            buffersRef.current.byId.set(cmdId, {
              kind: "command",
              id: cmdId,
              input: msg.trim(),
              output: "Switching conversation...",
              phase: "running",
            });
            buffersRef.current.order.push(cmdId);
            refreshDerived();

            try {
              // Validate conversation exists BEFORE updating state
              // (getResumeData throws 404/422 for non-existent conversations)
              if (agentState) {
                const client = await getClient();
                const resumeData = await getResumeData(
                  client,
                  agentState,
                  targetConvId,
                );

                // Only update state after validation succeeds
                setConversationId(targetConvId);
                settingsManager.setLocalLastSession(
                  { agentId, conversationId: targetConvId },
                  process.cwd(),
                );
                settingsManager.setGlobalLastSession({
                  agentId,
                  conversationId: targetConvId,
                });

                // Clear current transcript and static items
                buffersRef.current.byId.clear();
                buffersRef.current.order = [];
                buffersRef.current.tokenCount = 0;
                emittedIdsRef.current.clear();
                setStaticItems([]);
                setStaticRenderEpoch((e) => e + 1);

                // Build success message
                const currentAgentName = agentState.name || "Unnamed Agent";
                const successLines =
                  resumeData.messageHistory.length > 0
                    ? [
                        `Resumed conversation with "${currentAgentName}"`,
                        `⎿  Agent: ${agentId}`,
                        `⎿  Conversation: ${targetConvId}`,
                      ]
                    : [
                        `Switched to conversation with "${currentAgentName}"`,
                        `⎿  Agent: ${agentId}`,
                        `⎿  Conversation: ${targetConvId} (empty)`,
                      ];
                const successOutput = successLines.join("\n");
                const successItem: StaticItem = {
                  kind: "command",
                  id: uid("cmd"),
                  input: msg.trim(),
                  output: successOutput,
                  phase: "finished",
                  success: true,
                };

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
                  setStaticItems([separator, ...backfilledItems, successItem]);
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

                // Restore pending approvals if any (fixes #540 for /resume command)
                if (resumeData.pendingApprovals.length > 0) {
                  setPendingApprovals(resumeData.pendingApprovals);

                  // Analyze approval contexts (same logic as startup)
                  try {
                    const contexts = await Promise.all(
                      resumeData.pendingApprovals.map(async (approval) => {
                        const parsedArgs = safeJsonParseOr<
                          Record<string, unknown>
                        >(approval.toolArgs, {});
                        return await analyzeToolApproval(
                          approval.toolName,
                          parsedArgs,
                        );
                      }),
                    );
                    setApprovalContexts(contexts);
                  } catch (approvalError) {
                    // If analysis fails, leave context as null (will show basic options)
                    console.error(
                      "Failed to analyze resume approvals:",
                      approvalError,
                    );
                  }
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
              buffersRef.current.byId.set(cmdId, {
                kind: "command",
                id: cmdId,
                input: msg.trim(),
                output: `Failed to switch conversation: ${errorMsg}`,
                phase: "finished",
                success: false,
              });
              refreshDerived();
            } finally {
              setCommandRunning(false);
            }
            return { submitted: true };
          }

          // No conversation ID provided - show selector
          setActiveOverlay("conversations");
          return { submitted: true };
        }

        // Special handling for /search command - show message search
        if (msg.trim() === "/search") {
          setActiveOverlay("search");
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

          // /profile - open agent browser (now points to /agents)
          if (!subcommand) {
            setActiveOverlay("resume");
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

        // Special handling for /new command - create new agent dialog
        // Special handling for /pin command - pin current agent to project (or globally with -g)
        if (msg.trim() === "/pin" || msg.trim().startsWith("/pin ")) {
          const argsStr = msg.trim().slice(4).trim();

          // Parse args to check if name was provided
          const parts = argsStr.split(/\s+/).filter(Boolean);
          let hasNameArg = false;
          let isLocal = false;

          for (const part of parts) {
            if (part === "-l" || part === "--local") {
              isLocal = true;
            } else {
              hasNameArg = true;
            }
          }

          // If no name provided, show the pin dialog
          if (!hasNameArg) {
            setPinDialogLocal(isLocal);
            setActiveOverlay("pin");
            return { submitted: true };
          }

          // Name was provided, use existing behavior
          const profileCtx: ProfileCommandContext = {
            buffersRef,
            refreshDerived,
            agentId,
            agentName: agentName || "",
            setCommandRunning,
            setAgentName,
          };
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
          // Check for pending approvals before sending
          const approvalCheck = await checkPendingApprovalsForSlashCommand();
          if (approvalCheck.blocked) {
            return { submitted: false }; // Keep /skill in input box, user handles approval first
          }

          const cmdId = uid("cmd");

          // Extract optional description after `/skill`
          const [, ...rest] = trimmed.split(/\s+/);
          const description = rest.join(" ").trim();

          const initialOutput = description
            ? `Starting skill creation for: ${description}`
            : "Starting skill creation. I’ll load the creating-skills skill and ask a few questions about the skill you want to build...";

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
          // Check for pending approvals before sending (mirrors regular message flow)
          const approvalCheck = await checkPendingApprovalsForSlashCommand();
          if (approvalCheck.blocked) {
            return { submitted: false }; // Keep /remember in input box, user handles approval first
          }

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

        // Special handling for /plan command - enter plan mode
        if (trimmed === "/plan") {
          // Generate plan file path and enter plan mode
          const planPath = generatePlanFilePath();
          permissionMode.setPlanFilePath(planPath);
          permissionMode.setMode("plan");
          setUiPermissionMode("plan");

          // Add status message to transcript
          const statusId = uid("status");
          buffersRef.current.byId.set(statusId, {
            kind: "status",
            id: statusId,
            lines: [`Plan mode enabled. Plan file: ${planPath}`],
          });
          buffersRef.current.order.push(statusId);
          refreshDerived();

          return { submitted: true };
        }

        // Special handling for /init command - initialize agent memory
        if (trimmed === "/init") {
          // Check for pending approvals before sending
          const approvalCheck = await checkPendingApprovalsForSlashCommand();
          if (approvalCheck.blocked) {
            return { submitted: false }; // Keep /init in input box, user handles approval first
          }

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

            // Send trigger message instructing agent to load the initializing-memory skill
            const initMessage = `<system-reminder>
The user has requested memory initialization via /init.

## 1. Load the initializing-memory skill

First, check your \`loaded_skills\` memory block. If the \`initializing-memory\` skill is not already loaded:
1. Use the \`Skill\` tool with \`command: "load", skills: ["initializing-memory"]\`
2. The skill contains comprehensive instructions for memory initialization

If the skill fails to load, proceed with your best judgment based on these guidelines:
- Ask upfront questions (research depth, identity, related repos, workflow style)
- Research the project based on chosen depth
- Create/update memory blocks incrementally
- Reflect and verify completeness

## 2. Follow the loaded skill instructions

Once loaded, follow the instructions in the \`initializing-memory\` skill to complete the initialization.
${gitContext}
</system-reminder>`;

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

        if (trimmed.startsWith("/feedback")) {
          const maybeMsg = msg.slice("/feedback".length).trim();
          setFeedbackPrefill(maybeMsg);
          setActiveOverlay("feedback");
          return { submitted: true };
        }

        // === Custom command handling ===
        // Check BEFORE falling through to executeCommand()
        const { findCustomCommand, substituteArguments, expandBashCommands } =
          await import("./commands/custom.js");
        const commandName = trimmed.split(/\s+/)[0]?.slice(1) || ""; // e.g., "review" from "/review arg"
        const matchedCustom = await findCustomCommand(commandName);

        if (matchedCustom) {
          // Check for pending approvals before sending
          const approvalCheck = await checkPendingApprovalsForSlashCommand();
          if (approvalCheck.blocked) {
            return { submitted: false }; // Keep custom command in input box, user handles approval first
          }

          const cmdId = uid("cmd");

          // Extract arguments (everything after command name)
          const args = trimmed.slice(`/${matchedCustom.id}`.length).trim();

          // Build prompt: 1) substitute args, 2) expand bash commands
          let prompt = substituteArguments(matchedCustom.content, args);
          prompt = await expandBashCommands(prompt);

          // Show command in transcript (running phase for visual feedback)
          buffersRef.current.byId.set(cmdId, {
            kind: "command",
            id: cmdId,
            input: trimmed,
            output: `Running /${matchedCustom.id}...`,
            phase: "running",
          });
          buffersRef.current.order.push(cmdId);
          refreshDerived();

          setCommandRunning(true);

          try {
            // Mark command as finished BEFORE sending to agent
            // (matches /remember pattern - command succeeded in triggering agent)
            buffersRef.current.byId.set(cmdId, {
              kind: "command",
              id: cmdId,
              input: trimmed,
              output: `Running custom command...`,
              phase: "finished",
              success: true,
            });
            refreshDerived();

            // Send prompt to agent
            // NOTE: Unlike /remember, we DON'T append args separately because
            // they're already substituted into the prompt via $ARGUMENTS
            await processConversation([
              {
                type: "message",
                role: "user",
                content: `<system-reminder>\n${prompt}\n</system-reminder>`,
              },
            ]);
          } catch (error) {
            // Only catch errors from processConversation setup, not agent execution
            const errorDetails = formatErrorDetails(error, agentId);
            buffersRef.current.byId.set(cmdId, {
              kind: "command",
              id: cmdId,
              input: trimmed,
              output: `Failed to run command: ${errorDetails}`,
              phase: "finished",
              success: false,
            });
            refreshDerived();
          } finally {
            setCommandRunning(false);
          }

          return { submitted: true };
        }
        // === END custom command handling ===

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

      // Prepend ralph mode reminder if in ralph mode
      let ralphModeReminder = "";
      if (ralphMode.getState().isActive) {
        if (justActivatedRalph) {
          // First turn - use full first turn reminder, don't increment (already at 1)
          const ralphState = ralphMode.getState();
          ralphModeReminder = `${buildRalphFirstTurnReminder(ralphState)}\n\n`;
        } else {
          // Continuation after ESC - increment iteration and use shorter reminder
          ralphMode.incrementIteration();
          const ralphState = ralphMode.getState();
          ralphModeReminder = `${buildRalphContinuationReminder(ralphState)}\n\n`;
        }
      }

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

      // Build bash command prefix if there are cached commands
      let bashCommandPrefix = "";
      if (bashCommandCacheRef.current.length > 0) {
        bashCommandPrefix = `<system-reminder>
The messages below were generated by the user while running local commands using "bash mode" in the Letta Code CLI tool.
DO NOT respond to these messages or otherwise consider them in your response unless the user explicitly asks you to.
</system-reminder>
`;
        for (const cmd of bashCommandCacheRef.current) {
          bashCommandPrefix += `<bash-input>${cmd.input}</bash-input>\n<bash-output>${cmd.output}</bash-output>\n`;
        }
        // Clear the cache after building the prefix
        bashCommandCacheRef.current = [];
      }

      // Build memory reminder if interval is set and we've reached the Nth turn
      const memoryReminderContent = await buildMemoryReminder(
        turnCountRef.current,
      );

      // Increment turn count for next iteration
      turnCountRef.current += 1;

      // Build permission mode change alert if mode changed since last notification
      let permissionModeAlert = "";
      const currentMode = permissionMode.getMode();
      if (currentMode !== lastNotifiedModeRef.current) {
        const modeDescriptions: Record<PermissionMode, string> = {
          default: "Normal approval flow.",
          acceptEdits: "File edits auto-approved.",
          plan: "Read-only mode. Focus on exploration and planning.",
          bypassPermissions: "All tools auto-approved. Bias toward action.",
        };
        permissionModeAlert = `<system-alert>Permission mode changed to: ${currentMode}. ${modeDescriptions[currentMode]}</system-alert>\n\n`;
        lastNotifiedModeRef.current = currentMode;
      }

      // Combine reminders with content (session context first, then permission mode, then plan mode, then ralph mode, then skill unload, then bash commands, then memory reminder)
      const allReminders =
        sessionContextReminder +
        permissionModeAlert +
        planModeReminder +
        ralphModeReminder +
        skillUnloadReminder +
        bashCommandPrefix +
        memoryReminderContent;
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
      // Clear interrupted flag from previous turn
      buffersRef.current.interrupted = false;
      // Rotate to a new thinking message for this turn
      setThinkingMessage(getRandomThinkingVerb());
      // Show streaming state immediately for responsiveness (pending approval check takes ~100ms)
      setStreaming(true);
      refreshDerived();

      // Check for pending approvals before sending message (skip if we already have
      // a queued approval response to send first).
      // Only do eager check when resuming a session (LET-7101) - otherwise lazy recovery handles it
      if (needsEagerApprovalCheck && !queuedApprovalResults) {
        // Log for debugging
        const eagerStatusId = uid("status");
        buffersRef.current.byId.set(eagerStatusId, {
          kind: "status",
          id: eagerStatusId,
          lines: [
            "[EAGER CHECK] Checking for pending approvals (resume mode)...",
          ],
        });
        buffersRef.current.order.push(eagerStatusId);
        refreshDerived();

        try {
          const client = await getClient();
          // Fetch fresh agent state to check for pending approvals with accurate in-context messages
          const agent = await client.agents.retrieve(agentId);
          const { pendingApprovals: existingApprovals } = await getResumeData(
            client,
            agent,
            conversationIdRef.current,
          );

          // Remove eager check status
          buffersRef.current.byId.delete(eagerStatusId);
          buffersRef.current.order = buffersRef.current.order.filter(
            (id) => id !== eagerStatusId,
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
            // There are pending approvals - check permissions first (respects yolo mode)
            const approvalResults = await Promise.all(
              existingApprovals.map(async (approvalItem) => {
                if (!approvalItem.toolName) {
                  return {
                    approval: approvalItem,
                    permission: {
                      decision: "deny" as const,
                      reason: "Tool call incomplete - missing name",
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

            // Check if user cancelled during permission check
            if (
              userCancelledRef.current ||
              abortControllerRef.current?.signal.aborted
            ) {
              buffersRef.current.byId.delete(userId);
              const orderIndex = buffersRef.current.order.indexOf(userId);
              if (orderIndex !== -1) {
                buffersRef.current.order.splice(orderIndex, 1);
              }
              setStreaming(false);
              refreshDerived();
              return { submitted: false };
            }

            // Categorize by permission decision
            const needsUserInput: typeof approvalResults = [];
            const autoAllowed: typeof approvalResults = [];
            const autoDenied: typeof approvalResults = [];

            for (const ac of approvalResults) {
              const { approval, permission } = ac;
              let decision = permission.decision;

              // Some tools always need user input regardless of yolo mode
              if (
                alwaysRequiresUserInput(approval.toolName) &&
                decision === "allow"
              ) {
                decision = "ask";
              }

              if (decision === "ask") {
                needsUserInput.push(ac);
              } else if (decision === "deny") {
                autoDenied.push(ac);
              } else {
                autoAllowed.push(ac);
              }
            }

            // If all approvals can be auto-handled (yolo mode), process them immediately
            if (needsUserInput.length === 0) {
              // Precompute diffs for file edit tools before execution (both auto-allowed and needs-user-input)
              for (const ac of [...autoAllowed, ...needsUserInput]) {
                const toolName = ac.approval.toolName;
                const toolCallId = ac.approval.toolCallId;
                try {
                  const args = JSON.parse(ac.approval.toolArgs || "{}");

                  if (isFileWriteTool(toolName)) {
                    const filePath = args.file_path as string | undefined;
                    if (filePath) {
                      const result = computeAdvancedDiff({
                        kind: "write",
                        filePath,
                        content: (args.content as string) || "",
                      });
                      if (result.mode === "advanced") {
                        precomputedDiffsRef.current.set(toolCallId, result);
                      }
                    }
                  } else if (isFileEditTool(toolName)) {
                    const filePath = args.file_path as string | undefined;
                    if (filePath) {
                      // Check if it's a multi-edit (has edits array) or single edit
                      if (args.edits && Array.isArray(args.edits)) {
                        const result = computeAdvancedDiff({
                          kind: "multi_edit",
                          filePath,
                          edits: args.edits as Array<{
                            old_string: string;
                            new_string: string;
                            replace_all?: boolean;
                          }>,
                        });
                        if (result.mode === "advanced") {
                          precomputedDiffsRef.current.set(toolCallId, result);
                        }
                      } else {
                        const result = computeAdvancedDiff({
                          kind: "edit",
                          filePath,
                          oldString: (args.old_string as string) || "",
                          newString: (args.new_string as string) || "",
                          replaceAll: args.replace_all as boolean | undefined,
                        });
                        if (result.mode === "advanced") {
                          precomputedDiffsRef.current.set(toolCallId, result);
                        }
                      }
                    }
                  } else if (isPatchTool(toolName) && args.input) {
                    // Patch tools - parse hunks directly (patches ARE diffs)
                    const operations = parsePatchOperations(
                      args.input as string,
                    );
                    for (const op of operations) {
                      const key = `${toolCallId}:${op.path}`;
                      if (op.kind === "add" || op.kind === "update") {
                        const result = parsePatchToAdvancedDiff(
                          op.patchLines,
                          op.path,
                        );
                        if (result) {
                          precomputedDiffsRef.current.set(key, result);
                        }
                      }
                      // Delete operations don't need diffs
                    }
                  }
                } catch {
                  // Ignore errors in diff computation for auto-allowed tools
                }
              }

              // Set phase to "running" for auto-allowed tools
              setToolCallsRunning(
                buffersRef.current,
                autoAllowed.map((ac) => ac.approval.toolCallId),
              );
              refreshDerived();

              // Execute auto-allowed tools (sequential for writes, parallel for reads)
              const autoAllowedResults = await executeAutoAllowedTools(
                autoAllowed,
                (chunk) => onChunk(buffersRef.current, chunk),
                { onStreamingOutput: updateStreamingOutput },
              );

              // Create denial results for auto-denied and update UI
              const autoDeniedResults = autoDenied.map((ac) => {
                // Prefer the detailed reason over the short matchedRule name
                const reason = ac.permission.reason
                  ? `Permission denied: ${ac.permission.reason}`
                  : "matchedRule" in ac.permission && ac.permission.matchedRule
                    ? `Permission denied by rule: ${ac.permission.matchedRule}`
                    : "Permission denied: Unknown";

                // Update buffers with denial for UI
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
                  type: "approval" as const,
                  tool_call_id: ac.approval.toolCallId,
                  approve: false,
                  reason,
                };
              });

              refreshDerived();

              // Combine results and send directly with the user's message
              // (can't use state here as it won't be available until next render)
              const recoveryApprovalResults = [
                ...autoAllowedResults.map((ar) => ({
                  type: "approval" as const,
                  tool_call_id: ar.toolCallId,
                  approve: true,
                  tool_return: ar.result.toolReturn,
                })),
                ...autoDeniedResults,
              ];

              // Build and send initialInput directly
              const initialInput: Array<MessageCreate | ApprovalCreate> = [
                {
                  type: "approval",
                  approvals: recoveryApprovalResults,
                },
                {
                  type: "message",
                  role: "user",
                  content:
                    messageContent as unknown as MessageCreate["content"],
                },
              ];

              await processConversation(initialInput);
              clearPlaceholdersInText(msg);
              return { submitted: true };
            } else {
              // Some approvals need user input - show dialog
              // Remove the optimistic user message from transcript
              buffersRef.current.byId.delete(userId);
              const orderIndex = buffersRef.current.order.indexOf(userId);
              if (orderIndex !== -1) {
                buffersRef.current.order.splice(orderIndex, 1);
              }

              setStreaming(false);
              setPendingApprovals(needsUserInput.map((ac) => ac.approval));
              setApprovalContexts(
                needsUserInput
                  .map((ac) => ac.context)
                  .filter(Boolean) as ApprovalContext[],
              );

              // Precompute diffs for file edit tools before execution (both auto-allowed and needs-user-input)
              for (const ac of [...autoAllowed, ...needsUserInput]) {
                const toolName = ac.approval.toolName;
                const toolCallId = ac.approval.toolCallId;
                try {
                  const args = JSON.parse(ac.approval.toolArgs || "{}");

                  if (isFileWriteTool(toolName)) {
                    const filePath = args.file_path as string | undefined;
                    if (filePath) {
                      const result = computeAdvancedDiff({
                        kind: "write",
                        filePath,
                        content: (args.content as string) || "",
                      });
                      if (result.mode === "advanced") {
                        precomputedDiffsRef.current.set(toolCallId, result);
                      }
                    }
                  } else if (isFileEditTool(toolName)) {
                    const filePath = args.file_path as string | undefined;
                    if (filePath) {
                      // Check if it's a multi-edit (has edits array) or single edit
                      if (args.edits && Array.isArray(args.edits)) {
                        const result = computeAdvancedDiff({
                          kind: "multi_edit",
                          filePath,
                          edits: args.edits as Array<{
                            old_string: string;
                            new_string: string;
                            replace_all?: boolean;
                          }>,
                        });
                        if (result.mode === "advanced") {
                          precomputedDiffsRef.current.set(toolCallId, result);
                        }
                      } else {
                        const result = computeAdvancedDiff({
                          kind: "edit",
                          filePath,
                          oldString: (args.old_string as string) || "",
                          newString: (args.new_string as string) || "",
                          replaceAll: args.replace_all as boolean | undefined,
                        });
                        if (result.mode === "advanced") {
                          precomputedDiffsRef.current.set(toolCallId, result);
                        }
                      }
                    }
                  } else if (isPatchTool(toolName) && args.input) {
                    // Patch tools - parse hunks directly (patches ARE diffs)
                    const operations = parsePatchOperations(
                      args.input as string,
                    );
                    for (const op of operations) {
                      const key = `${toolCallId}:${op.path}`;
                      if (op.kind === "add" || op.kind === "update") {
                        const result = parsePatchToAdvancedDiff(
                          op.patchLines,
                          op.path,
                        );
                        if (result) {
                          precomputedDiffsRef.current.set(key, result);
                        }
                      }
                      // Delete operations don't need diffs
                    }
                  }
                } catch {
                  // Ignore errors in diff computation for auto-allowed tools
                }
              }

              // Execute auto-allowed tools (sequential for writes, parallel for reads)
              const autoAllowedWithResults = await executeAutoAllowedTools(
                autoAllowed,
                (chunk) => onChunk(buffersRef.current, chunk),
                { onStreamingOutput: updateStreamingOutput },
              );

              // Create denial reasons for auto-denied and update UI
              const autoDeniedWithReasons = autoDenied.map((ac) => {
                // Prefer the detailed reason over the short matchedRule name
                const reason = ac.permission.reason
                  ? `Permission denied: ${ac.permission.reason}`
                  : "matchedRule" in ac.permission && ac.permission.matchedRule
                    ? `Permission denied by rule: ${ac.permission.matchedRule}`
                    : "Permission denied: Unknown";

                // Update buffers with denial for UI
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

              // Store auto-handled results to send along with user decisions
              setAutoHandledResults(autoAllowedWithResults);
              setAutoDeniedApprovals(autoDeniedWithReasons);

              refreshDerived();
              return { submitted: false };
            }
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
        interruptQueuedRef.current = false;
      }

      initialInput.push({
        type: "message",
        role: "user",
        content: messageContent as unknown as MessageCreate["content"],
      });

      await processConversation(initialInput, { submissionGeneration });

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
      isAgentBusy,
      setStreaming,
      setCommandRunning,
      pendingRalphConfig,
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
      !anySelectorOpen && // Don't dequeue while a selector/overlay is open
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
    anySelectorOpen,
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
        // Ensure interrupted flag is cleared for this execution
        buffersRef.current.interrupted = false;

        const approvalAbortController = new AbortController();
        toolAbortControllerRef.current = approvalAbortController;

        // Combine all decisions using snapshots
        const allDecisions = [
          ...approvalResultsSnapshot,
          ...(additionalDecision ? [additionalDecision] : []),
        ];

        executingToolCallIdsRef.current = allDecisions
          .filter((decision) => decision.type === "approve")
          .map((decision) => decision.approval.toolCallId);

        // Set phase to "running" for all approved tools
        setToolCallsRunning(
          buffersRef.current,
          allDecisions
            .filter((d) => d.type === "approve")
            .map((d) => d.approval.toolCallId),
        );
        refreshDerived();

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
          {
            abortSignal: approvalAbortController.signal,
            onStreamingOutput: updateStreamingOutput,
          },
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
            setQueuedApprovalResults(allResults as ApprovalResult[]);
          }
          setStreaming(false);

          // Reset queue-cancel flag so dequeue effect can fire
          waitingForQueueCancelRef.current = false;
          queueSnapshotRef.current = [];
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
        executingToolCallIdsRef.current = [];
        interruptQueuedRef.current = false;
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
              "../agent/approval-execution"
            );
            const executedResults = await executeApprovalBatch(
              allDecisions,
              (chunk) => {
                onChunk(buffersRef.current, chunk);
                refreshDerived();
              },
              { onStreamingOutput: updateStreamingOutput },
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
      await withCommandLock(async () => {
        // Declare cmdId outside try block so it's accessible in catch
        let cmdId: string | null = null;

        try {
          // Find the selected model from models.json first (for loading message)
          const { models } = await import("../agent/model");
          let selectedModel = models.find((m) => m.id === modelId);

          // If not found in static list, it might be a BYOK model where id === handle
          if (!selectedModel && modelId.includes("/")) {
            // Treat it as a BYOK model - the modelId is actually the handle
            // Look up the context window from the API-cached model info
            const { getModelContextWindow } = await import(
              "../agent/available-models"
            );
            const apiContextWindow = getModelContextWindow(modelId);

            selectedModel = {
              id: modelId,
              handle: modelId,
              label: modelId.split("/").pop() ?? modelId,
              description: "Custom model",
              updateArgs: apiContextWindow
                ? { context_window: apiContextWindow }
                : undefined,
            } as unknown as (typeof models)[number];
          }

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

          // Update the agent with new model and config args
          const { updateAgentLLMConfig } = await import("../agent/modify");

          const updatedConfig = await updateAgentLLMConfig(
            agentId,
            selectedModel.handle,
            selectedModel.updateArgs,
          );
          setLlmConfig(updatedConfig);
          setCurrentModelId(modelId);

          // After switching models, only switch toolset if it actually changes
          const { isOpenAIModel, isGeminiModel } = await import(
            "../tools/manager"
          );
          const targetToolset:
            | "codex"
            | "codex_snake"
            | "default"
            | "gemini"
            | "gemini_snake"
            | "none" = isOpenAIModel(selectedModel.handle ?? "")
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
            | "none"
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
        }
      });
    },
    [agentId, refreshDerived, currentToolset, withCommandLock],
  );

  const handleSystemPromptSelect = useCallback(
    async (promptId: string) => {
      await withCommandLock(async () => {
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

          // Update the agent's system prompt
          const { updateAgentSystemPromptRaw } = await import(
            "../agent/modify"
          );
          const result = await updateAgentSystemPromptRaw(
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
        }
      });
    },
    [agentId, refreshDerived, withCommandLock],
  );

  const handleToolsetSelect = useCallback(
    async (
      toolsetId:
        | "codex"
        | "codex_snake"
        | "default"
        | "gemini"
        | "gemini_snake"
        | "none",
    ) => {
      await withCommandLock(async () => {
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
        }
      });
    },
    [agentId, refreshDerived, withCommandLock],
  );

  // Handle escape when profile confirmation is pending
  const handleFeedbackSubmit = useCallback(
    async (message: string) => {
      closeOverlay();

      await withCommandLock(async () => {
        const cmdId = uid("cmd");

        try {
          const resolvedMessage = resolvePlaceholders(message);

          // Immediately add command to transcript with "running" phase
          buffersRef.current.byId.set(cmdId, {
            kind: "command",
            id: cmdId,
            input: "/feedback",
            output: "Sending feedback...",
            phase: "running",
          });
          buffersRef.current.order.push(cmdId);
          refreshDerived();

          const settings = settingsManager.getSettings();
          const apiKey =
            process.env.LETTA_API_KEY || settings.env?.LETTA_API_KEY;

          // Only send anonymized, safe settings for debugging
          const {
            env: _env,
            refreshToken: _refreshToken,
            ...safeSettings
          } = settings;

          const response = await fetch(
            "https://api.letta.com/v1/metadata/feedback",
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
                "X-Letta-Source": "letta-code",
                "X-Letta-Code-Device-ID": settingsManager.getOrCreateDeviceId(),
              },
              body: JSON.stringify({
                message: resolvedMessage,
                feature: "letta-code",
                agent_id: agentId,
                session_id: telemetry.getSessionId(),
                version: process.env.npm_package_version || "unknown",
                platform: process.platform,
                settings: JSON.stringify(safeSettings),
              }),
            },
          );

          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(
              `Failed to send feedback (${response.status}): ${errorText}`,
            );
          }

          buffersRef.current.byId.set(cmdId, {
            kind: "command",
            id: cmdId,
            input: "/feedback",
            output:
              "Feedback submitted! To chat with the Letta dev team live, join our Discord (https://discord.gg/letta).",
            phase: "finished",
            success: true,
          });
          refreshDerived();
        } catch (error) {
          const errorDetails = formatErrorDetails(error, agentId);
          buffersRef.current.byId.set(cmdId, {
            kind: "command",
            id: cmdId,
            input: "/feedback",
            output: `Failed to send feedback: ${errorDetails}`,
            phase: "finished",
            success: false,
          });
          refreshDerived();
        }
      });
    },
    [agentId, refreshDerived, withCommandLock, closeOverlay],
  );

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
  }, []);

  // Handle permission mode changes from the Input component (e.g., shift+tab cycling)
  const handlePermissionModeChange = useCallback((mode: PermissionMode) => {
    // When entering plan mode via tab cycling, generate and set the plan file path
    if (mode === "plan") {
      const planPath = generatePlanFilePath();
      permissionMode.setPlanFilePath(planPath);
    }
    // permissionMode.setMode() is called in InputRich.tsx before this callback
    setUiPermissionMode(mode);
  }, []);

  const handlePlanApprove = useCallback(
    async (acceptEdits: boolean = false) => {
      const currentIndex = approvalResults.length;
      const approval = pendingApprovals[currentIndex];
      if (!approval) return;

      const isLast = currentIndex + 1 >= pendingApprovals.length;

      // Capture plan file path BEFORE exiting plan mode (for post-approval rendering)
      const planFilePath = permissionMode.getPlanFilePath();
      lastPlanFilePathRef.current = planFilePath;

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
      setStreaming,
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

  // Auto-reject ExitPlanMode if plan mode is not enabled or plan file doesn't exist
  useEffect(() => {
    const currentIndex = approvalResults.length;
    const approval = pendingApprovals[currentIndex];
    if (approval?.toolName === "ExitPlanMode") {
      // First check if plan mode is enabled
      if (permissionMode.getMode() !== "plan") {
        // Plan mode state was lost (e.g., CLI restart) - queue rejection with helpful message
        // This is different from immediate rejection because we want the user to see what happened
        // and be able to type their next message

        // Add status message to explain what happened
        const statusId = uid("status");
        buffersRef.current.byId.set(statusId, {
          kind: "status",
          id: statusId,
          lines: ["⚠️ Plan mode session expired (use /plan to re-enter)"],
        });
        buffersRef.current.order.push(statusId);

        // Queue denial to send with next message (same pattern as handleCancelApprovals)
        const denialResults = [
          {
            type: "approval" as const,
            tool_call_id: approval.toolCallId,
            approve: false,
            reason:
              "Plan mode session expired (CLI restarted). Use EnterPlanMode to re-enter plan mode, or request the user to re-enter plan mode.",
          },
        ];
        setQueuedApprovalResults(denialResults);

        // Mark tool as cancelled in buffers
        markIncompleteToolsAsCancelled(buffersRef.current);
        refreshDerived();

        // Clear all approval state (same as handleCancelApprovals)
        setPendingApprovals([]);
        setApprovalContexts([]);
        setApprovalResults([]);
        setAutoHandledResults([]);
        setAutoDeniedApprovals([]);
        return;
      }
      // Then check if plan file exists (keep existing behavior - immediate rejection)
      // This case means plan mode IS active, but agent forgot to write the plan file
      if (!planFileExists()) {
        const planFilePath = permissionMode.getPlanFilePath();
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
      parseMemoryPreference(questions, answers);

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

      setThinkingMessage(getRandomThinkingVerb());
      refreshDerived();

      // Mark as eagerly committed to prevent duplicate rendering
      // (sendAllResults will call setToolCallsRunning which resets phase to "running")
      if (approval.toolCallId) {
        eagerCommittedPreviewsRef.current.add(approval.toolCallId);
      }

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
        return ln.phase !== "finished";
      }
      if (!tokenStreamingEnabled && ln.phase === "streaming") return false;
      return ln.phase === "streaming";
    });
  }, [lines, tokenStreamingEnabled]);

  // Subscribe to subagent state for reactive overflow detection
  const { agents: subagents } = useSyncExternalStore(
    subscribeToSubagents,
    getSubagentSnapshot,
  );

  // Overflow detection: disable animations when live content exceeds viewport
  // This prevents Ink's clearTerminal flicker on every re-render cycle
  const shouldAnimate = useMemo(() => {
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

    return estimatedHeight < terminalRows;
  }, [liveItems, terminalRows, subagents.length]);

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
            "→ **/memory**    view your agent's memory blocks",
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

      // Add release notes first (above everything) - same styling as rest of status block
      if (releaseNotes) {
        statusLines.push(releaseNotes);
        statusLines.push(""); // blank line separator
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
      commitEligibleLines(buffersRef.current);
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

  return (
    <Box key={resumeKey} flexDirection="column">
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
              <ToolCallMessage
                line={item}
                precomputedDiffs={precomputedDiffsRef.current}
                lastPlanFilePath={lastPlanFilePathRef.current}
              />
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
            ) : item.kind === "bash_command" ? (
              <BashCommandMessage line={item} />
            ) : item.kind === "approval_preview" ? (
              <ApprovalPreview
                toolName={item.toolName}
                toolArgs={item.toolArgs}
                precomputedDiff={item.precomputedDiff}
                allDiffs={precomputedDiffsRef.current}
                planContent={item.planContent}
                planFilePath={item.planFilePath}
                toolCallId={item.toolCallId}
              />
            ) : null}
          </Box>
        )}
      </Static>

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

                    // Skip tool calls that were eagerly committed to staticItems
                    // (e.g., ExitPlanMode preview) - but only AFTER approval is complete
                    // We still need to render the approval options while awaiting approval
                    if (
                      ln.kind === "tool_call" &&
                      ln.toolCallId &&
                      eagerCommittedPreviewsRef.current.has(ln.toolCallId) &&
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
                          />
                        ) : ln.kind === "user" ? (
                          <UserMessage line={ln} />
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
                  />
                </Box>
              )}

              {/* Subagent group display - shows running/completed subagents */}
              <SubagentGroupDisplay />
            </AnimationProvider>

            {/* Exit stats - shown when exiting via double Ctrl+C */}
            {showExitStats && (
              <Box flexDirection="column" marginTop={1}>
                <Text dimColor>
                  {formatUsageStats({
                    stats: sessionStatsRef.current.getSnapshot(),
                  })}
                </Text>
                <Text dimColor>Resume this agent with:</Text>
                <Text color={colors.link.url}>
                  {/* Show -n "name" if agent has name and is pinned, otherwise --agent */}
                  {agentName &&
                  (settingsManager.getLocalPinnedAgents().includes(agentId) ||
                    settingsManager.getGlobalPinnedAgents().includes(agentId))
                    ? `letta -n "${agentName}"`
                    : `letta --agent ${agentId}`}
                </Text>
                <Text> </Text>
                <Text dimColor>Resume this conversation with:</Text>
                <Text color={colors.link.url}>
                  {`letta --conv ${conversationId}`}
                </Text>
              </Box>
            )}

            {/* Input row - always mounted to preserve state */}
            <Box marginTop={1}>
              <Input
                visible={
                  !showExitStats &&
                  pendingApprovals.length === 0 &&
                  !anySelectorOpen
                }
                streaming={
                  streaming && !abortControllerRef.current?.signal.aborted
                }
                tokenCount={tokenCount}
                thinkingMessage={thinkingMessage}
                onSubmit={onSubmit}
                onBashSubmit={handleBashSubmit}
                permissionMode={uiPermissionMode}
                onPermissionModeChange={handlePermissionModeChange}
                onExit={handleExit}
                onInterrupt={handleInterrupt}
                interruptRequested={interruptRequested}
                agentId={agentId}
                agentName={agentName}
                currentModel={currentModelDisplay}
                currentModelProvider={currentModelProvider}
                messageQueue={messageQueue}
                onEnterQueueEditMode={handleEnterQueueEditMode}
                onEscapeCancel={
                  profileConfirmPending ? handleProfileEscapeCancel : undefined
                }
                ralphActive={uiRalphActive}
                ralphPending={pendingRalphConfig !== null}
                ralphPendingYolo={pendingRalphConfig?.isYolo ?? false}
                onRalphExit={handleRalphExit}
                conversationId={conversationId}
              />
            </Box>

            {/* Model Selector - conditionally mounted as overlay */}
            {activeOverlay === "model" && (
              <ModelSelector
                currentModelId={currentModelId ?? undefined}
                onSelect={handleModelSelect}
                onCancel={closeOverlay}
                filterProvider={modelSelectorOptions.filterProvider}
                forceRefresh={modelSelectorOptions.forceRefresh}
              />
            )}

            {/* Toolset Selector - conditionally mounted as overlay */}
            {activeOverlay === "toolset" && (
              <ToolsetSelector
                currentToolset={currentToolset ?? undefined}
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

            {/* Subagent Manager - for managing custom subagents */}
            {activeOverlay === "subagent" && (
              <SubagentManager onClose={closeOverlay} />
            )}

            {/* Agent Selector - for browsing/selecting agents */}
            {activeOverlay === "resume" && (
              <AgentSelector
                currentAgentId={agentId}
                onSelect={async (id) => {
                  closeOverlay();
                  await handleAgentSelect(id);
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
                onSelect={async (convId) => {
                  closeOverlay();

                  // Skip if already on this conversation
                  if (convId === conversationId) {
                    const cmdId = uid("cmd");
                    buffersRef.current.byId.set(cmdId, {
                      kind: "command",
                      id: cmdId,
                      input: "/resume",
                      output: "Already on this conversation",
                      phase: "finished",
                      success: true,
                    });
                    buffersRef.current.order.push(cmdId);
                    refreshDerived();
                    return;
                  }

                  // Lock input for async operation
                  setCommandRunning(true);

                  const inputCmd = "/resume";
                  const cmdId = uid("cmd");

                  // Show loading indicator while switching
                  buffersRef.current.byId.set(cmdId, {
                    kind: "command",
                    id: cmdId,
                    input: inputCmd,
                    output: "Switching conversation...",
                    phase: "running",
                  });
                  buffersRef.current.order.push(cmdId);
                  refreshDerived();

                  try {
                    // Validate conversation exists BEFORE updating state
                    // (getResumeData throws 404/422 for non-existent conversations)
                    if (agentState) {
                      const client = await getClient();
                      const resumeData = await getResumeData(
                        client,
                        agentState,
                        convId,
                      );

                      // Only update state after validation succeeds
                      setConversationId(convId);
                      settingsManager.setLocalLastSession(
                        { agentId, conversationId: convId },
                        process.cwd(),
                      );
                      settingsManager.setGlobalLastSession({
                        agentId,
                        conversationId: convId,
                      });

                      // Clear current transcript and static items
                      buffersRef.current.byId.clear();
                      buffersRef.current.order = [];
                      buffersRef.current.tokenCount = 0;
                      emittedIdsRef.current.clear();
                      setStaticItems([]);
                      setStaticRenderEpoch((e) => e + 1);

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
                      const successItem: StaticItem = {
                        kind: "command",
                        id: uid("cmd"),
                        input: inputCmd,
                        output: successOutput,
                        phase: "finished",
                        success: true,
                      };

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
                        setPendingApprovals(resumeData.pendingApprovals);

                        // Analyze approval contexts (same logic as startup)
                        try {
                          const contexts = await Promise.all(
                            resumeData.pendingApprovals.map(
                              async (approval) => {
                                const parsedArgs = safeJsonParseOr<
                                  Record<string, unknown>
                                >(approval.toolArgs, {});
                                return await analyzeToolApproval(
                                  approval.toolName,
                                  parsedArgs,
                                );
                              },
                            ),
                          );
                          setApprovalContexts(contexts);
                        } catch (approvalError) {
                          // If analysis fails, leave context as null (will show basic options)
                          console.error(
                            "Failed to analyze resume approvals:",
                            approvalError,
                          );
                        }
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
                    buffersRef.current.byId.set(cmdId, {
                      kind: "command",
                      id: cmdId,
                      input: inputCmd,
                      output: `Failed to switch conversation: ${errorMsg}`,
                      phase: "finished",
                      success: false,
                    });
                    refreshDerived();
                  } finally {
                    setCommandRunning(false);
                  }
                }}
                onNewConversation={async () => {
                  closeOverlay();

                  // Lock input for async operation
                  setCommandRunning(true);

                  const inputCmd = "/resume";
                  const cmdId = uid("cmd");

                  // Show loading indicator
                  buffersRef.current.byId.set(cmdId, {
                    kind: "command",
                    id: cmdId,
                    input: inputCmd,
                    output: "Creating new conversation...",
                    phase: "running",
                  });
                  buffersRef.current.order.push(cmdId);
                  refreshDerived();

                  try {
                    // Create a new conversation
                    const client = await getClient();
                    const conversation = await client.conversations.create({
                      agent_id: agentId,
                      isolated_block_labels: [...ISOLATED_BLOCK_LABELS],
                    });
                    setConversationId(conversation.id);
                    settingsManager.setLocalLastSession(
                      { agentId, conversationId: conversation.id },
                      process.cwd(),
                    );
                    settingsManager.setGlobalLastSession({
                      agentId,
                      conversationId: conversation.id,
                    });

                    // Clear current transcript and static items
                    buffersRef.current.byId.clear();
                    buffersRef.current.order = [];
                    buffersRef.current.tokenCount = 0;
                    emittedIdsRef.current.clear();
                    setStaticItems([]);
                    setStaticRenderEpoch((e) => e + 1);

                    // Build success command with agent + conversation info
                    const currentAgentName =
                      agentState?.name || "Unnamed Agent";
                    const shortConvId = conversation.id.slice(0, 20);
                    const successLines = [
                      `Started new conversation with "${currentAgentName}"`,
                      `⎿  Agent: ${agentId}`,
                      `⎿  Conversation: ${shortConvId}... (new)`,
                    ];
                    const successItem: StaticItem = {
                      kind: "command",
                      id: uid("cmd"),
                      input: inputCmd,
                      output: successLines.join("\n"),
                      phase: "finished",
                      success: true,
                    };
                    setStaticItems([successItem]);
                    setLines(toLines(buffersRef.current));
                  } catch (error) {
                    const errorCmdId = uid("cmd");
                    buffersRef.current.byId.set(errorCmdId, {
                      kind: "command",
                      id: errorCmdId,
                      input: inputCmd,
                      output: `Failed to create conversation: ${error instanceof Error ? error.message : String(error)}`,
                      phase: "finished",
                      success: false,
                    });
                    buffersRef.current.order.push(errorCmdId);
                    refreshDerived();
                  } finally {
                    setCommandRunning(false);
                  }
                }}
                onCancel={closeOverlay}
              />
            )}

            {/* Message Search - conditionally mounted as overlay */}
            {activeOverlay === "search" && (
              <MessageSearch onClose={closeOverlay} />
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
            {activeOverlay === "memory" && (
              <MemoryTabViewer
                blocks={agentState?.memory?.blocks || []}
                agentId={agentId}
                onClose={closeOverlay}
                conversationId={conversationId}
              />
            )}

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
                  closeOverlay();
                  const cmdId = uid("cmd");
                  buffersRef.current.byId.set(cmdId, {
                    kind: "command",
                    id: cmdId,
                    input: "/mcp connect",
                    output:
                      `Successfully created MCP server "${serverName}"\n` +
                      `ID: ${serverId}\n` +
                      `Discovered ${toolCount} tool${toolCount === 1 ? "" : "s"}\n` +
                      "Open /mcp to attach or detach tools for this server.",
                    phase: "finished",
                    success: true,
                  });
                  buffersRef.current.order.push(cmdId);
                  refreshDerived();
                }}
                onCancel={closeOverlay}
              />
            )}

            {/* Help Dialog - conditionally mounted as overlay */}
            {activeOverlay === "help" && <HelpDialog onClose={closeOverlay} />}

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
                  closeOverlay();
                  setCommandRunning(true);

                  const cmdId = uid("cmd");
                  const scopeText = pinDialogLocal
                    ? "to this project"
                    : "globally";
                  const displayName =
                    newName || agentName || agentId.slice(0, 12);

                  buffersRef.current.byId.set(cmdId, {
                    kind: "command",
                    id: cmdId,
                    input: "/pin",
                    output: `Pinning "${displayName}" ${scopeText}...`,
                    phase: "running",
                  });
                  buffersRef.current.order.push(cmdId);
                  refreshDerived();

                  try {
                    const client = await getClient();

                    // Rename if new name provided
                    if (newName && newName !== agentName) {
                      await client.agents.update(agentId, { name: newName });
                      setAgentName(newName);
                    }

                    // Pin the agent
                    if (pinDialogLocal) {
                      settingsManager.pinLocal(agentId);
                    } else {
                      settingsManager.pinGlobal(agentId);
                    }

                    buffersRef.current.byId.set(cmdId, {
                      kind: "command",
                      id: cmdId,
                      input: "/pin",
                      output: `Pinned "${newName || agentName || agentId.slice(0, 12)}" ${scopeText}.`,
                      phase: "finished",
                      success: true,
                    });
                  } catch (error) {
                    buffersRef.current.byId.set(cmdId, {
                      kind: "command",
                      id: cmdId,
                      input: "/pin",
                      output: `Failed to pin: ${error}`,
                      phase: "finished",
                      success: false,
                    });
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
