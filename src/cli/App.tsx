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
import { getResumeData } from "../agent/check-approval";
import { getClient } from "../agent/client";
import { sendMessageStream } from "../agent/message";
import { SessionStats } from "../agent/stats";
import type { ApprovalContext } from "../permissions/analyzer";
import { permissionMode } from "../permissions/mode";
import {
  analyzeToolApproval,
  checkToolPermission,
  executeTool,
  savePermissionRule,
} from "../tools/manager";
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
import { type ApprovalRequest, drainStream } from "./helpers/stream";
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
  agentId,
  agentState,
  loadingState = "ready",
  continueSession = false,
  startupApproval = null,
  messageHistory = [],
  tokenStreaming = true,
}: {
  agentId: string;
  agentState?: AgentState | null;
  loadingState?:
    | "assembling"
    | "upserting"
    | "initializing"
    | "checking"
    | "ready";
  continueSession?: boolean;
  startupApproval?: ApprovalRequest | null;
  messageHistory?: LettaMessageUnion[];
  tokenStreaming?: boolean;
}) {
  // Whether a stream is in flight (disables input)
  const [streaming, setStreaming] = useState(false);

  // Whether an interrupt has been requested for the current stream
  const [interruptRequested, setInterruptRequested] = useState(false);

  // Whether a command is running (disables input but no streaming UI)
  const [commandRunning, setCommandRunning] = useState(false);

  // If we have an approval request, we should show the approval dialog instead of the input area
  const [pendingApproval, setPendingApproval] =
    useState<ApprovalRequest | null>(null);
  const [approvalContext, setApprovalContext] =
    useState<ApprovalContext | null>(null);

  // If we have a plan approval request, show the plan dialog
  const [planApprovalPending, setPlanApprovalPending] = useState<{
    plan: string;
    toolCallId: string;
    toolArgs: string;
  } | null>(null);

  // Model selector state
  const [modelSelectorOpen, setModelSelectorOpen] = useState(false);
  const [llmConfig, setLlmConfig] = useState<LlmConfig | null>(null);

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
    if (loadingState === "ready" && startupApproval) {
      // Check if this is an ExitPlanMode approval - route to plan dialog
      if (startupApproval.toolName === "ExitPlanMode") {
        const parsedArgs = safeJsonParseOr<Record<string, unknown>>(
          startupApproval.toolArgs,
          {},
        );
        const plan = (parsedArgs.plan as string) || "No plan provided";

        setPlanApprovalPending({
          plan,
          toolCallId: startupApproval.toolCallId,
          toolArgs: startupApproval.toolArgs,
        });
      } else {
        // Regular tool approval
        setPendingApproval(startupApproval);

        // Analyze approval context for restored approval
        const analyzeStartupApproval = async () => {
          try {
            const parsedArgs = safeJsonParseOr<Record<string, unknown>>(
              startupApproval.toolArgs,
              {},
            );
            const context = await analyzeToolApproval(
              startupApproval.toolName,
              parsedArgs,
            );
            setApprovalContext(context);
          } catch (error) {
            // If analysis fails, leave context as null (will show basic options)
            console.error("Failed to analyze startup approval:", error);
          }
        };

        analyzeStartupApproval();
      }
    }
  }, [loadingState, startupApproval]);

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
        } catch (error) {
          console.error("Error fetching llm_config:", error);
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
      let currentInput = initialInput;

      try {
        setStreaming(true);
        abortControllerRef.current = new AbortController();

        while (true) {
          // Stream one turn
          const stream = await sendMessageStream(agentId, currentInput);
          const { stopReason, approval, apiDurationMs, lastRunId } =
            await drainStream(
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
            if (!approval) {
              appendError(
                `Unexpected null approval with stop reason: ${stopReason}`,
              );
              setStreaming(false);
              return;
            }

            const { toolCallId, toolName, toolArgs } = approval;

            // Special handling for ExitPlanMode - show plan dialog
            if (toolName === "ExitPlanMode") {
              const parsedArgs = safeJsonParseOr<Record<string, unknown>>(
                toolArgs,
                {},
              );
              const plan = (parsedArgs.plan as string) || "No plan provided";

              setPlanApprovalPending({ plan, toolCallId, toolArgs });
              setStreaming(false);
              return;
            }

            // Check permission using new permission system
            const parsedArgs = safeJsonParseOr<Record<string, unknown>>(
              toolArgs,
              {},
            );
            const permission = await checkToolPermission(toolName, parsedArgs);

            // Handle deny decision - use same flow as manual deny
            if (permission.decision === "deny") {
              const denyReason = `Permission denied by rule: ${permission.matchedRule || permission.reason}`;

              // Rotate to a new thinking message
              setThinkingMessage(getRandomThinkingMessage());

              // Send denial back to agent (same as manual deny)
              await processConversation([
                {
                  type: "approval",
                  approval_request_id: toolCallId,
                  approve: false,
                  reason: denyReason,
                },
              ]);
              return;
            }

            // Handle ask decision - show approval dialog
            if (permission.decision === "ask") {
              // Analyze approval context for smart button text
              const context = await analyzeToolApproval(toolName, parsedArgs);

              // Pause: show approval dialog and exit loop
              // Handlers will restart the loop when user decides
              setPendingApproval({ toolCallId, toolName, toolArgs });
              setApprovalContext(context);
              setStreaming(false);
              return;
            }

            // Permission is "allow" - auto-execute tool and continue loop
            const toolResult = await executeTool(toolName, parsedArgs);

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
            refreshDerived();

            // Set up next input and continue loop
            currentInput = [
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
            ];
            continue; // Loop continues naturally
          }

          // Unexpected stop reason (error, llm_api_error, etc.)
          // Mark incomplete tool calls as finished to prevent stuck blinking UI
          markIncompleteToolsAsCancelled(buffersRef.current);

          // Fetch error details from the run if available
          const errorDetails = `Unexpected stop reason: ${stopReason}`;
          if (lastRunId) {
            try {
              const client = await getClient();

              // Try to get the run itself first
              const run = await client.runs.retrieve(lastRunId);
              console.warn("[error-details] Run object:", run);

              // Check if run has error information
              // if (run.error_data?.message) {
              //   errorDetails = `${stopReason}: ${run.error_data.message}`;
              // } else if (run.status === "failed" || run.status === "error") {
              //   // Try to get step error details
              //   const stepsPage = await client.runs.steps.list(lastRunId, {
              //     limit: 1,
              //     order: "desc",
              //   });
              //   const lastStep = stepsPage.items[0];
              //   if (lastStep?.error_data?.message) {
              //     errorDetails = `${stopReason}: ${lastStep.error_data.message}`;
              //   }
              // }
            } catch (e) {
              // If we can't fetch error details, just show the stop reason
              console.error("Failed to fetch error details:", e);
            }
          } else {
            console.warn(
              "[error-details] No lastRunId available, cannot fetch error details",
            );
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
      const cancelResult = await client.agents.messages.cancel(agentId);
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
            output: "Clearing credentials...",
            phase: "running",
          });
          buffersRef.current.order.push(cmdId);
          refreshDerived();

          setCommandRunning(true);

          try {
            const { settingsManager } = await import("../settings-manager");
            const currentSettings = settingsManager.getSettings();
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
          const { pendingApproval: existingApproval } = await getResumeData(
            client,
            agent,
          );

          if (existingApproval) {
            // There's a pending approval - show it and DON'T send the message yet
            // The message will be restored to the input field for the user to decide
            // Note: The user message is already in the transcript (optimistic update)
            setStreaming(false); // Stop streaming indicator
            setPendingApproval(existingApproval);

            // Analyze approval context
            const parsedArgs = safeJsonParseOr<Record<string, unknown>>(
              existingApproval.toolArgs,
              {},
            );
            const context = await analyzeToolApproval(
              existingApproval.toolName,
              parsedArgs,
            );
            setApprovalContext(context);

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
    ],
  );

  // Handle approval callbacks
  const handleApprove = useCallback(async () => {
    if (!pendingApproval) return;

    const { toolCallId, toolName, toolArgs } = pendingApproval;
    setPendingApproval(null);

    try {
      // Execute the tool
      const parsedArgs = safeJsonParseOr<Record<string, unknown>>(toolArgs, {});
      const toolResult = await executeTool(toolName, parsedArgs);

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
      // Rotate to a new thinking message for this continuation
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
  }, [pendingApproval, processConversation, appendError, refreshDerived]);

  const handleApproveAlways = useCallback(
    async (scope?: "project" | "session") => {
      if (!pendingApproval || !approvalContext) return;

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

      // Clear approval context and approve
      setApprovalContext(null);
      await handleApprove();
    },
    [pendingApproval, approvalContext, handleApprove, refreshDerived],
  );

  const handleDeny = useCallback(
    async (reason: string) => {
      if (!pendingApproval) return;

      const { toolCallId } = pendingApproval;
      setPendingApproval(null);

      try {
        // Rotate to a new thinking message for this continuation
        setThinkingMessage(getRandomThinkingMessage());

        // Restart conversation loop with denial response
        await processConversation([
          {
            type: "approval",
            approval_request_id: toolCallId,
            approve: false,
            reason: reason || "User denied the tool execution",
            // TODO the above is legacy?
            // approvals: [
            //   {
            //     type: "approval",
            //     toolCallId,
            //     approve: false,
            //     reason: reason || "User denied the tool execution",
            //   },
            // ],
          },
        ]);
      } catch (e) {
        appendError(String(e));
        setStreaming(false);
      }
    },
    [pendingApproval, processConversation, appendError],
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
        if (!tokenStreamingEnabled && ln.phase === "streaming") return false;
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
              !pendingApproval &&
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
                !pendingApproval &&
                !modelSelectorOpen &&
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
            />

            {/* Model Selector - conditionally mounted as overlay */}
            {modelSelectorOpen && (
              <ModelSelector
                currentModel={llmConfig?.model}
                onSelect={handleModelSelect}
                onCancel={() => setModelSelectorOpen(false)}
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
            {pendingApproval && (
              <>
                <Box height={1} />
                <ApprovalDialog
                  approvalRequest={pendingApproval}
                  approvalContext={approvalContext}
                  onApprove={handleApprove}
                  onApproveAlways={handleApproveAlways}
                  onDeny={handleDeny}
                />
              </>
            )}
          </>
        )}
      </Box>
    </Box>
  );
}
