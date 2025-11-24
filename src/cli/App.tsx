// src/cli/App.tsx

import { APIError } from "@letta-ai/letta-client/core/error";
import type {
  AgentState,
  MessageCreate,
} from "@letta-ai/letta-client/resources/agents/agents";
import type {
  ApprovalCreate,
  LettaMessageUnion,
} from "@letta-ai/letta-client/resources/agents/messages";
import type { LlmConfig } from "@letta-ai/letta-client/resources/models/models";
import { Box, Static } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ApprovalResult } from "../agent/approval-execution";
import { getResumeData } from "../agent/check-approval";
import { getClient } from "../agent/client";
import { setCurrentAgentId } from "../agent/context";
import { sendMessageStream } from "../agent/message";
import { linkToolsToAgent, unlinkToolsFromAgent } from "../agent/modify";
import { SessionStats } from "../agent/stats";
import type { ApprovalContext } from "../permissions/analyzer";
import { permissionMode } from "../permissions/mode";
import { updateProjectSettings } from "../settings";
import type { ToolExecutionResult } from "../tools/manager";
import {
  analyzeToolApproval,
  checkToolPermission,
  executeTool,
  savePermissionRule,
} from "../tools/manager";
import { AgentSelector } from "./components/AgentSelector";
// import { ApprovalDialog } from "./components/ApprovalDialog";
import { ApprovalDialog } from "./components/ApprovalDialogRich";
// import { AssistantMessage } from "./components/AssistantMessage";
import { AssistantMessage } from "./components/AssistantMessageRich";
import { CommandMessage } from "./components/CommandMessage";
// import { ErrorMessage } from "./components/ErrorMessage";
import { ErrorMessage } from "./components/ErrorMessageRich";
// import { Input } from "./components/Input";
import { Input } from "./components/InputRich";
import { ModelSelector } from "./components/ModelSelector";
import { PlanModeDialog } from "./components/PlanModeDialog";
// import { ReasoningMessage } from "./components/ReasoningMessage";
import { ReasoningMessage } from "./components/ReasoningMessageRich";
import { SessionStats as SessionStatsComponent } from "./components/SessionStats";
// import { ToolCallMessage } from "./components/ToolCallMessage";
import { ToolCallMessage } from "./components/ToolCallMessageRich";
// import { UserMessage } from "./components/UserMessage";
import { UserMessage } from "./components/UserMessageRich";
import { WelcomeScreen } from "./components/WelcomeScreen";
import {
  type Buffers,
  createBuffers,
  type Line,
  markIncompleteToolsAsCancelled,
  onChunk,
  toLines,
} from "./helpers/accumulator";
import { backfillBuffers } from "./helpers/backfill";
import {
  buildMessageContentFromDisplay,
  clearPlaceholdersInText,
} from "./helpers/pasteRegistry";
import { safeJsonParseOr } from "./helpers/safeJsonParse";
import { type ApprovalRequest, drainStreamWithResume } from "./helpers/stream";
import { getRandomThinkingMessage } from "./helpers/thinkingMessages";
import { useTerminalWidth } from "./hooks/useTerminalWidth";

const CLEAR_SCREEN_AND_HOME = "\u001B[2J\u001B[H";

// Feature flag: Check for pending approvals before sending messages
// This prevents infinite thinking state when there's an orphaned approval
// Can be disabled if the latency check adds too much overhead
const CHECK_PENDING_APPROVALS_BEFORE_SEND = true;

// tiny helper for unique ids (avoid overwriting prior user lines)
function uid(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Get plan mode system reminder if in plan mode
function getPlanModeReminder(): string {
  if (permissionMode.getMode() !== "plan") {
    return "";
  }

  // Use bundled reminder text for binary compatibility
  const { PLAN_MODE_REMINDER } = require("../agent/promptAssets");
  return PLAN_MODE_REMINDER;
}

// Items that have finished rendering and no longer change
type StaticItem =
  | {
      kind: "welcome";
      id: string;
      snapshot: {
        continueSession: boolean;
        agentState?: AgentState | null;
        terminalWidth: number;
      };
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
  tokenStreaming = true,
}: {
  agentId: string;
  agentState?: AgentState | null;
  loadingState?:
    | "assembling"
    | "upserting"
    | "linking"
    | "unlinking"
    | "initializing"
    | "checking"
    | "ready";
  continueSession?: boolean;
  startupApproval?: ApprovalRequest | null; // Deprecated: use startupApprovals
  startupApprovals?: ApprovalRequest[];
  messageHistory?: LettaMessageUnion[];
  tokenStreaming?: boolean;
}) {
  // Track current agent (can change when swapping)
  const [agentId, setAgentId] = useState(initialAgentId);
  const [agentState, setAgentState] = useState(initialAgentState);

  // Sync with prop changes (e.g., when parent updates from "loading" to actual ID)
  useEffect(() => {
    if (initialAgentId !== agentId) {
      setAgentId(initialAgentId);
    }
  }, [initialAgentId, agentId]);

  useEffect(() => {
    if (initialAgentState !== agentState) {
      setAgentState(initialAgentState);
    }
  }, [initialAgentState, agentState]);

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
  const [isExecutingTool, _setIsExecutingTool] = useState(false);

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

  // If we have a plan approval request, show the plan dialog
  const [planApprovalPending, setPlanApprovalPending] = useState<{
    plan: string;
    toolCallId: string;
    toolArgs: string;
  } | null>(null);

  // Model selector state
  const [modelSelectorOpen, setModelSelectorOpen] = useState(false);
  const [llmConfig, setLlmConfig] = useState<LlmConfig | null>(null);
  const [agentName, setAgentName] = useState<string | null>(null);

  // Agent selector state
  const [agentSelectorOpen, setAgentSelectorOpen] = useState(false);

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
    // console.log(`[COMMIT] Checking ${b.order.length} lines for commit eligibility`);
    for (const id of b.order) {
      if (emittedIdsRef.current.has(id)) continue;
      const ln = b.byId.get(id);
      if (!ln) continue;
      // console.log(`[COMMIT] Checking ${id}: kind=${ln.kind}, phase=${(ln as any).phase}`);
      if (ln.kind === "user" || ln.kind === "error") {
        emittedIdsRef.current.add(id);
        newlyCommitted.push({ ...ln });
        // console.log(`[COMMIT] Committed ${id} (${ln.kind})`);
        continue;
      }
      // Commands with phase should only commit when finished
      if (ln.kind === "command") {
        if (!ln.phase || ln.phase === "finished") {
          emittedIdsRef.current.add(id);
          newlyCommitted.push({ ...ln });
          // console.log(`[COMMIT] Committed ${id} (command, finished)`);
        }
        continue;
      }
      if ("phase" in ln && ln.phase === "finished") {
        emittedIdsRef.current.add(id);
        newlyCommitted.push({ ...ln });
        // console.log(`[COMMIT] Committed ${id} (${ln.kind}, finished)`);
      } else {
        // console.log(`[COMMIT] NOT committing ${id} (phase=${(ln as any).phase})`);
      }
    }
    if (newlyCommitted.length > 0) {
      // console.log(`[COMMIT] Total committed: ${newlyCommitted.length} items`);
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
  useEffect(() => {
    // Use new plural field if available, otherwise wrap singular in array for backward compat
    const approvals =
      startupApprovals?.length > 0
        ? startupApprovals
        : startupApproval
          ? [startupApproval]
          : [];

    if (loadingState === "ready" && approvals.length > 0) {
      // Check if this is an ExitPlanMode approval - route to plan dialog
      const planApproval = approvals.find((a) => a.toolName === "ExitPlanMode");
      if (planApproval) {
        const parsedArgs = safeJsonParseOr<Record<string, unknown>>(
          planApproval.toolArgs,
          {},
        );
        const plan = (parsedArgs.plan as string) || "No plan provided";

        setPlanApprovalPending({
          plan,
          toolCallId: planApproval.toolCallId,
          toolArgs: planApproval.toolArgs,
        });
      } else {
        // Regular tool approvals (may be multiple for parallel tools)
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
              terminalWidth: columns,
            },
          },
        ]);
      }
      // Use backfillBuffers to properly populate the transcript from history
      backfillBuffers(buffersRef.current, messageHistory);
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
        setStreaming(true);
        abortControllerRef.current = new AbortController();

        while (true) {
          // Stream one turn
          const stream = await sendMessageStream(agentId, currentInput);
          const { stopReason, approval, approvals, apiDurationMs, lastRunId } =
            await drainStreamWithResume(
              stream,
              buffersRef.current,
              refreshDerivedThrottled,
              abortControllerRef.current.signal,
            );

          // Track API duration
          sessionStatsRef.current.endTurn(apiDurationMs);
          sessionStatsRef.current.updateUsageFromBuffers(buffersRef.current);

          // Immediate refresh after stream completes to show final state
          refreshDerived();

          // Case 1: Turn ended normally
          if (stopReason === "end_turn") {
            setStreaming(false);
            return;
          }

          // Case 1.5: Stream was cancelled by user
          if (stopReason === "cancelled") {
            appendError("Stream interrupted by user");
            setStreaming(false);
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

            // Check each approval for ExitPlanMode special case
            const planApproval = approvalsToProcess.find(
              (a) => a.toolName === "ExitPlanMode",
            );
            if (planApproval) {
              const parsedArgs = safeJsonParseOr<Record<string, unknown>>(
                planApproval.toolArgs,
                {},
              );
              const plan = (parsedArgs.plan as string) || "No plan provided";

              setPlanApprovalPending({
                plan,
                toolCallId: planApproval.toolCallId,
                toolArgs: planApproval.toolArgs,
              });
              setStreaming(false);
              return;
            }

            // Check permissions for all approvals
            const approvalResults = await Promise.all(
              approvalsToProcess.map(async (approvalItem) => {
                // Check if approval is incomplete (missing name or arguments)
                if (!approvalItem.toolName || !approvalItem.toolArgs) {
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
            const needsUserInput = approvalResults.filter(
              (ac) => ac.permission.decision === "ask",
            );
            const autoDenied = approvalResults.filter(
              (ac) => ac.permission.decision === "deny",
            );
            const autoAllowed = approvalResults.filter(
              (ac) => ac.permission.decision === "allow",
            );

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

            // Create denial results for auto-denied tools
            const autoDeniedResults = autoDenied.map((ac) => ({
              approval: ac.approval,
              reason:
                "matchedRule" in ac.permission && ac.permission.matchedRule
                  ? `Permission denied by rule: ${ac.permission.matchedRule}`
                  : `Permission denied: ${ac.permission.reason || "Unknown reason"}`,
            }));

            // If all are auto-handled, continue immediately without showing dialog
            if (needsUserInput.length === 0) {
              // Rotate to a new thinking message
              setThinkingMessage(getRandomThinkingMessage());
              refreshDerived();

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

              await processConversation([
                {
                  type: "approval",
                  approvals: allResults,
                },
              ]);
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
          let errorDetails = `Unexpected stop reason: ${stopReason}`;
          if (lastRunId) {
            try {
              const client = await getClient();
              const run = await client.runs.retrieve(lastRunId);

              // Check if run has error information in metadata
              if (run.metadata?.error) {
                const error = run.metadata.error as {
                  type?: string;
                  message?: string;
                  detail?: string;
                };
                const errorType = error.type ? `[${error.type}] ` : "";
                const errorMessage = error.message || "An error occurred";
                const errorDetail = error.detail ? `\n${error.detail}` : "";
                errorDetails = `${errorType}${errorMessage}${errorDetail}`;
              }
            } catch (_e) {
              // If we can't fetch error details, let user know
              appendError(
                `${errorDetails}\n(Unable to fetch additional error details from server)`,
              );
              return;
            }
          }

          appendError(errorDetails);

          setStreaming(false);
          refreshDerived();
          return;
        }
      } catch (e) {
        // Handle APIError from streaming (event: error)
        if (e instanceof APIError && e.error?.error) {
          const { type, message, detail } = e.error.error;
          const errorType = type ? `[${type}] ` : "";
          const errorMessage = message || "An error occurred";
          const errorDetail = detail ? `:\n${detail}` : "";
          appendError(`${errorType}${errorMessage}${errorDetail}`);
        } else {
          // Fallback for non-API errors
          appendError(e instanceof Error ? e.message : String(e));
        }
        setStreaming(false);
      } finally {
        abortControllerRef.current = null;
      }
    },
    [agentId, appendError, refreshDerived, refreshDerivedThrottled],
  );

  const handleExit = useCallback(() => {
    setShowExitStats(true);
    // Give React time to render the stats, then exit
    setTimeout(() => {
      process.exit(0);
    }, 100);
  }, []);

  const handleInterrupt = useCallback(async () => {
    if (!streaming || interruptRequested) return;

    setInterruptRequested(true);
    try {
      const client = await getClient();

      // Send cancel request to backend
      const _cancelResult = await client.agents.messages.cancel(agentId);
      // console.error("cancelResult", JSON.stringify(cancelResult, null, 2));

      // WORKAROUND: Also abort the stream immediately since backend cancellation is buggy
      // TODO: Once backend is fixed, comment out the immediate abort below and uncomment the timeout version
      // if (abortControllerRef.current) {
      //   abortControllerRef.current.abort();
      // }

      // FUTURE: Use this timeout-based abort once backend properly sends "cancelled" stop reason
      // This gives the backend 5 seconds to gracefully close the stream before forcing abort
      // const abortTimeout = setTimeout(() => {
      //   if (abortControllerRef.current) {
      //     abortControllerRef.current.abort();
      //   }
      // }, 5000);
      //
      // // The timeout will be cleared in processConversation's finally block when stream ends
    } catch (e) {
      appendError(`Failed to interrupt stream: ${String(e)}`);
      setInterruptRequested(false);
    }
  }, [agentId, streaming, interruptRequested, appendError]);

  // Reset interrupt flag when streaming ends
  useEffect(() => {
    if (!streaming) {
      setInterruptRequested(false);
    }
  }, [streaming]);

  const onSubmit = useCallback(
    async (message?: string): Promise<{ submitted: boolean }> => {
      const msg = message?.trim() ?? "";
      if (!msg || streaming || commandRunning) return { submitted: false };

      // Handle commands (messages starting with "/")
      if (msg.startsWith("/")) {
        // Special handling for /model command - opens selector
        if (msg.trim() === "/model") {
          setModelSelectorOpen(true);
          return { submitted: true };
        }

        // Special handling for /agent command - show agent link
        if (msg.trim() === "/agent") {
          const cmdId = uid("cmd");
          const agentUrl = `https://app.letta.com/projects/default-project/agents/${agentId}`;
          buffersRef.current.byId.set(cmdId, {
            kind: "command",
            id: cmdId,
            input: msg,
            output: agentUrl,
            phase: "finished",
            success: true,
          });
          buffersRef.current.order.push(cmdId);
          refreshDerived();
          return { submitted: true };
        }

        // Special handling for /exit command - show stats and exit
        if (msg.trim() === "/exit") {
          handleExit();
          return { submitted: true };
        }

        // Special handling for /logout command - clear credentials and exit
        if (msg.trim() === "/logout") {
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
            buffersRef.current.byId.set(cmdId, {
              kind: "command",
              id: cmdId,
              input: msg,
              output: `Failed: ${error instanceof Error ? error.message : String(error)}`,
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
            buffersRef.current.byId.set(cmdId, {
              kind: "command",
              id: cmdId,
              input: msg,
              output: `Failed: ${error instanceof Error ? error.message : String(error)}`,
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
            buffersRef.current.byId.set(cmdId, {
              kind: "command",
              id: cmdId,
              input: msg,
              output: `Failed: ${error instanceof Error ? error.message : String(error)}`,
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
            buffersRef.current.byId.set(cmdId, {
              kind: "command",
              id: cmdId,
              input: msg,
              output: `Failed: ${error instanceof Error ? error.message : String(error)}`,
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
            buffersRef.current.byId.set(cmdId, {
              kind: "command",
              id: cmdId,
              input: msg,
              output: `Failed: ${error instanceof Error ? error.message : String(error)}`,
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
            await client.agents.modify(agentId, { name: newName });
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
            buffersRef.current.byId.set(cmdId, {
              kind: "command",
              id: cmdId,
              input: msg,
              output: `Failed: ${error instanceof Error ? error.message : String(error)}`,
              phase: "finished",
              success: false,
            });
            refreshDerived();
          } finally {
            setCommandRunning(false);
          }
          return { submitted: true };
        }

        // Special handling for /swap command - switch to a different agent
        if (msg.trim().startsWith("/swap")) {
          const parts = msg.trim().split(/\s+/);
          const targetAgentId = parts.slice(1).join(" ");

          // If no agent ID provided, open agent selector
          if (!targetAgentId) {
            setAgentSelectorOpen(true);
            return { submitted: true };
          }

          // Validate and swap to specified agent ID
          const cmdId = uid("cmd");
          buffersRef.current.byId.set(cmdId, {
            kind: "command",
            id: cmdId,
            input: msg,
            output: `Switching to agent ${targetAgentId}...`,
            phase: "running",
          });
          buffersRef.current.order.push(cmdId);
          refreshDerived();

          setCommandRunning(true);

          try {
            const client = await getClient();
            // Fetch new agent
            const agent = await client.agents.retrieve(targetAgentId);

            // Fetch agent's message history
            const messagesPage =
              await client.agents.messages.list(targetAgentId);
            const messages = messagesPage.items;

            // Update project settings with new agent
            await updateProjectSettings({ lastAgent: targetAgentId });

            // Clear current transcript
            buffersRef.current.byId.clear();
            buffersRef.current.order = [];
            buffersRef.current.tokenCount = 0;
            emittedIdsRef.current.clear();
            setStaticItems([]);

            // Update agent state
            setAgentId(targetAgentId);
            setAgentState(agent);
            setAgentName(agent.name);
            setLlmConfig(agent.llm_config);

            // Add welcome screen for new agent
            welcomeCommittedRef.current = false;
            setStaticItems([
              {
                kind: "welcome",
                id: `welcome-${Date.now().toString(36)}`,
                snapshot: {
                  continueSession: true,
                  agentState: agent,
                  terminalWidth: columns,
                },
              },
            ]);

            // Backfill message history
            if (messages.length > 0) {
              hasBackfilledRef.current = false;
              backfillBuffers(buffersRef.current, messages);
              refreshDerived();
              commitEligibleLines(buffersRef.current);
              hasBackfilledRef.current = true;
            }

            // Add success command to transcript
            const successCmdId = uid("cmd");
            buffersRef.current.byId.set(successCmdId, {
              kind: "command",
              id: successCmdId,
              input: msg,
              output: `✓ Switched to agent "${agent.name || targetAgentId}"`,
              phase: "finished",
              success: true,
            });
            buffersRef.current.order.push(successCmdId);
            refreshDerived();
          } catch (error) {
            buffersRef.current.byId.set(cmdId, {
              kind: "command",
              id: cmdId,
              input: msg,
              output: `Failed: ${error instanceof Error ? error.message : String(error)}`,
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
          buffersRef.current.byId.set(cmdId, {
            kind: "command",
            id: cmdId,
            input: msg,
            output: `Failed: ${error instanceof Error ? error.message : String(error)}`,
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
      const messageContent =
        planModeReminder && typeof contentParts === "string"
          ? planModeReminder + contentParts
          : Array.isArray(contentParts) && planModeReminder
            ? [
                { type: "text" as const, text: planModeReminder },
                ...contentParts,
              ]
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

      // Check for pending approvals before sending message
      if (CHECK_PENDING_APPROVALS_BEFORE_SEND) {
        try {
          const client = await getClient();
          // Fetch fresh agent state to check for pending approvals with accurate in-context messages
          const agent = await client.agents.retrieve(agentId);
          const { pendingApprovals: existingApprovals } = await getResumeData(
            client,
            agent,
          );

          if (existingApprovals && existingApprovals.length > 0) {
            // There are pending approvals - show them and DON'T send the message yet
            // The message will be restored to the input field for the user to decide
            // Note: The user message is already in the transcript (optimistic update)
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
            setApprovalContexts(contexts);

            // Return false = message NOT submitted, will be restored to input
            return { submitted: false };
          }
        } catch (error) {
          // If check fails, proceed anyway (don't block user)
          console.error("Failed to check pending approvals:", error);
        }
      }

      // Start the conversation loop
      await processConversation([
        {
          type: "message",
          role: "user",
          content: messageContent as unknown as MessageCreate["content"],
        },
      ]);

      // Clean up placeholders after submission
      clearPlaceholdersInText(msg);

      return { submitted: true };
    },
    [
      streaming,
      commandRunning,
      processConversation,
      tokenStreamingEnabled,
      refreshDerived,
      agentId,
      handleExit,
      columns,
      commitEligibleLines,
    ],
  );

  // Helper to send all approval results when done
  const sendAllResults = useCallback(
    async (
      additionalDecision?:
        | { type: "approve"; approval: ApprovalRequest }
        | { type: "deny"; approval: ApprovalRequest; reason: string },
    ) => {
      // Combine all decisions
      const allDecisions = [
        ...approvalResults,
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
        },
      );

      // Combine with auto-handled and auto-denied results
      const allResults = [
        ...autoHandledResults.map((ar) => ({
          type: "tool" as const,
          tool_call_id: ar.toolCallId,
          tool_return: ar.result.toolReturn,
          status: ar.result.status,
          stdout: ar.result.stdout,
          stderr: ar.result.stderr,
        })),
        ...autoDeniedApprovals.map((ad) => ({
          type: "approval" as const,
          tool_call_id: ad.approval.toolCallId,
          approve: false,
          reason: ad.reason,
        })),
        ...executedResults,
      ];

      // Dev-only validation: ensure outgoing IDs match expected IDs
      if (process.env.NODE_ENV !== "production") {
        // Include ALL tool call IDs: auto-handled, auto-denied, and pending approvals
        const expectedIds = new Set([
          ...autoHandledResults.map((ar) => ar.toolCallId),
          ...autoDeniedApprovals.map((ad) => ad.approval.toolCallId),
          ...pendingApprovals.map((a) => a.toolCallId),
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

      // Clear state
      setPendingApprovals([]);
      setApprovalContexts([]);
      setApprovalResults([]);
      setAutoHandledResults([]);
      setAutoDeniedApprovals([]);

      // Rotate to a new thinking message
      setThinkingMessage(getRandomThinkingMessage());
      refreshDerived();

      // Continue conversation with all results
      await processConversation([
        {
          type: "approval",
          approvals: allResults as ApprovalResult[],
        },
      ]);
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
    const currentIndex = approvalResults.length;
    const currentApproval = pendingApprovals[currentIndex];

    if (!currentApproval) return;

    try {
      // Store approval decision (don't execute yet - batch execute after all approvals)
      const decision = {
        type: "approve" as const,
        approval: currentApproval,
      };

      // Check if we're done with all approvals
      if (currentIndex + 1 >= pendingApprovals.length) {
        // All approvals collected, execute and send to backend
        await sendAllResults(decision);
      } else {
        // Not done yet, store decision and show next approval
        setApprovalResults((prev) => [...prev, decision]);
      }
    } catch (e) {
      appendError(String(e));
      setStreaming(false);
    }
  }, [pendingApprovals, approvalResults, sendAllResults, appendError]);

  const handleApproveAlways = useCallback(
    async (scope?: "project" | "session") => {
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

      // Approve current tool
      await handleApproveCurrent();
    },
    [
      approvalResults,
      approvalContexts,
      pendingApprovals,
      handleApproveCurrent,
      refreshDerived,
    ],
  );

  const handleDenyCurrent = useCallback(
    async (reason: string) => {
      const currentIndex = approvalResults.length;
      const currentApproval = pendingApprovals[currentIndex];

      if (!currentApproval) return;

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
          setThinkingMessage(getRandomThinkingMessage());
          await sendAllResults(decision);
        } else {
          // Not done yet, store decision and show next approval
          setApprovalResults((prev) => [...prev, decision]);
        }
      } catch (e) {
        appendError(String(e));
        setStreaming(false);
      }
    },
    [pendingApprovals, approvalResults, sendAllResults, appendError],
  );

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

        // Update the same command with final result
        buffersRef.current.byId.set(cmdId, {
          kind: "command",
          id: cmdId,
          input: `/model ${modelId}`,
          output: `Switched to ${selectedModel.label}`,
          phase: "finished",
          success: true,
        });
        refreshDerived();
      } catch (error) {
        // Mark command as failed (only if cmdId was created)
        if (cmdId) {
          buffersRef.current.byId.set(cmdId, {
            kind: "command",
            id: cmdId,
            input: `/model ${modelId}`,
            output: `Failed to switch model: ${error instanceof Error ? error.message : String(error)}`,
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
    [agentId, refreshDerived],
  );

  const handleAgentSelect = useCallback(
    async (targetAgentId: string) => {
      setAgentSelectorOpen(false);

      const cmdId = uid("cmd");
      buffersRef.current.byId.set(cmdId, {
        kind: "command",
        id: cmdId,
        input: `/swap ${targetAgentId}`,
        output: `Switching to agent ${targetAgentId}...`,
        phase: "running",
      });
      buffersRef.current.order.push(cmdId);
      refreshDerived();

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

        // Clear current transcript
        buffersRef.current.byId.clear();
        buffersRef.current.order = [];
        buffersRef.current.tokenCount = 0;
        emittedIdsRef.current.clear();
        setStaticItems([]);

        // Update agent state
        setAgentId(targetAgentId);
        setAgentState(agent);
        setAgentName(agent.name);
        setLlmConfig(agent.llm_config);

        // Add welcome screen for new agent
        welcomeCommittedRef.current = false;
        setStaticItems([
          {
            kind: "welcome",
            id: `welcome-${Date.now().toString(36)}`,
            snapshot: {
              continueSession: true,
              agentState: agent,
              terminalWidth: columns,
            },
          },
        ]);

        // Backfill message history
        if (messages.length > 0) {
          hasBackfilledRef.current = false;
          backfillBuffers(buffersRef.current, messages);
          refreshDerived();
          commitEligibleLines(buffersRef.current);
          hasBackfilledRef.current = true;
        }

        // Add success command to transcript
        const successCmdId = uid("cmd");
        buffersRef.current.byId.set(successCmdId, {
          kind: "command",
          id: successCmdId,
          input: `/swap ${targetAgentId}`,
          output: `✓ Switched to agent "${agent.name || targetAgentId}"`,
          phase: "finished",
          success: true,
        });
        buffersRef.current.order.push(successCmdId);
        refreshDerived();
      } catch (error) {
        buffersRef.current.byId.set(cmdId, {
          kind: "command",
          id: cmdId,
          input: `/swap ${targetAgentId}`,
          output: `Failed: ${error instanceof Error ? error.message : String(error)}`,
          phase: "finished",
          success: false,
        });
        refreshDerived();
      } finally {
        setCommandRunning(false);
      }
    },
    [refreshDerived, commitEligibleLines, columns],
  );

  // Track permission mode changes for UI updates
  const [uiPermissionMode, setUiPermissionMode] = useState(
    permissionMode.getMode(),
  );

  const handlePlanApprove = useCallback(
    async (acceptEdits: boolean = false) => {
      if (!planApprovalPending) return;

      const { toolCallId, toolArgs } = planApprovalPending;
      setPlanApprovalPending(null);

      // Exit plan mode
      const newMode = acceptEdits ? "acceptEdits" : "default";
      permissionMode.setMode(newMode);
      setUiPermissionMode(newMode);

      try {
        // Execute ExitPlanMode tool
        const parsedArgs = safeJsonParseOr<Record<string, unknown>>(
          toolArgs,
          {},
        );
        const toolResult = await executeTool("ExitPlanMode", parsedArgs);

        // Update buffers with tool return
        onChunk(buffersRef.current, {
          message_type: "tool_return_message",
          id: "dummy",
          date: new Date().toISOString(),
          tool_call_id: toolCallId,
          tool_return: toolResult.toolReturn,
          status: toolResult.status,
          stdout: toolResult.stdout,
          stderr: toolResult.stderr,
        });

        // Rotate to a new thinking message
        setThinkingMessage(getRandomThinkingMessage());
        refreshDerived();

        // Restart conversation loop with approval response
        await processConversation([
          {
            type: "approval",
            approvals: [
              {
                type: "tool",
                tool_call_id: toolCallId,
                tool_return: toolResult.toolReturn,
                status: toolResult.status,
                stdout: toolResult.stdout,
                stderr: toolResult.stderr,
              },
            ],
          },
        ]);
      } catch (e) {
        appendError(String(e));
        setStreaming(false);
      }
    },
    [planApprovalPending, processConversation, appendError, refreshDerived],
  );

  const handlePlanKeepPlanning = useCallback(
    async (reason: string) => {
      if (!planApprovalPending) return;

      const { toolCallId } = planApprovalPending;
      setPlanApprovalPending(null);

      // Stay in plan mode - send denial with user's feedback to agent
      try {
        // Rotate to a new thinking message for this continuation
        setThinkingMessage(getRandomThinkingMessage());

        // Restart conversation loop with denial response
        await processConversation([
          {
            type: "approval",
            approval_request_id: toolCallId,
            approve: false,
            reason:
              reason ||
              "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.",
          },
        ]);
      } catch (e) {
        appendError(String(e));
        setStreaming(false);
      }
    },
    [planApprovalPending, processConversation, appendError],
  );

  // Live area shows only in-progress items
  const liveItems = useMemo(() => {
    return lines.filter((ln) => {
      if (!("phase" in ln)) return false;
      if (ln.kind === "command") {
        return ln.phase === "running";
      }
      if (ln.kind === "tool_call") {
        // Always show tool calls in progress, regardless of tokenStreaming setting
        return ln.phase !== "finished";
      }
      if (!tokenStreamingEnabled && ln.phase === "streaming") return false;
      return ln.phase === "streaming";
    });
  }, [lines, tokenStreamingEnabled]);

  // Commit welcome snapshot once when ready for fresh sessions (no history)
  useEffect(() => {
    if (
      loadingState === "ready" &&
      !welcomeCommittedRef.current &&
      messageHistory.length === 0
    ) {
      welcomeCommittedRef.current = true;
      setStaticItems((prev) => [
        ...prev,
        {
          kind: "welcome",
          id: `welcome-${Date.now().toString(36)}`,
          snapshot: {
            continueSession,
            agentState,
            terminalWidth: columns,
          },
        },
      ]);
    }
  }, [
    loadingState,
    continueSession,
    messageHistory.length,
    columns,
    agentState,
  ]);

  return (
    <Box flexDirection="column" gap={1}>
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
            ) : item.kind === "error" ? (
              <ErrorMessage line={item} />
            ) : (
              <CommandMessage line={item} />
            )}
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
            {liveItems.length > 0 &&
              pendingApprovals.length === 0 &&
              !planApprovalPending && (
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
                      ) : (
                        <CommandMessage line={ln} />
                      )}
                    </Box>
                  ))}
                </Box>
              )}

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
                !agentSelectorOpen &&
                !planApprovalPending
              }
              streaming={streaming}
              commandRunning={commandRunning}
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
            />

            {/* Model Selector - conditionally mounted as overlay */}
            {modelSelectorOpen && (
              <ModelSelector
                currentModel={llmConfig?.model}
                onSelect={handleModelSelect}
                onCancel={() => setModelSelectorOpen(false)}
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

            {/* Plan Mode Dialog - below live items */}
            {planApprovalPending && (
              <>
                <Box height={1} />
                <PlanModeDialog
                  plan={planApprovalPending.plan}
                  onApprove={() => handlePlanApprove(false)}
                  onApproveAndAcceptEdits={() => handlePlanApprove(true)}
                  onKeepPlanning={handlePlanKeepPlanning}
                />
              </>
            )}

            {/* Approval Dialog - below live items */}
            {pendingApprovals.length > 0 && (
              <>
                <Box height={1} />
                <ApprovalDialog
                  approvals={
                    pendingApprovals[approvalResults.length]
                      ? ([
                          pendingApprovals[
                            approvalResults.length
                          ] as ApprovalRequest,
                        ] as ApprovalRequest[])
                      : []
                  }
                  approvalContexts={
                    approvalContexts[approvalResults.length]
                      ? ([
                          approvalContexts[
                            approvalResults.length
                          ] as ApprovalContext,
                        ] as ApprovalContext[])
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
                />
              </>
            )}
          </>
        )}
      </Box>
    </Box>
  );
}
