// Parsing of a subagent's headless `--output-format stream-json` output: the
// per-line event handlers, the streaming state they mutate, and the final
// result parsed from stdout.
//
// Extracted from `manager.ts`. `executeSubagent` owns an `ExecutionState`,
// feeds each stdout line to `processStreamEvent`, and falls back to
// `parseResultFromStdout`. These helpers depend only on lower-level state/URL
// helpers and the shared `SubagentResult` type — never back on the manager.

import {
  addToolCall,
  emitStreamEvent,
  updateSubagent,
} from "@/agent/subagent-state.js";
import type { EnqueueReceipt } from "@/backend/api/conversation-enqueue";
import { buildAgentReference } from "@/cli/helpers/app-urls";
import { toolOutputText } from "@/tools/impl/external-tool-call";
import {
  recordTaskEvent,
  recordTaskProgressToolCall,
} from "@/tools/impl/task-transcript";
import { debugWarn } from "@/utils/debug";
import { getErrorMessage } from "@/utils/error";
import type { SubagentResult } from ".";

/**
 * State tracked during subagent execution
 */
export interface ExecutionState {
  agentId: string | null;
  conversationId: string | null;
  finalResult: string | null;
  finalError: string | null;
  /**
   * Set when the child submitted a computer-routed send with `--no-wait` and
   * exited with the enqueue receipt instead of a reply. The parent tracks the
   * remote turn from this receipt.
   */
  enqueueReceipt: EnqueueReceipt | null;
  resultStats: {
    durationMs: number;
    totalTokens: number;
    stepCount?: number;
  } | null;
  displayedToolCalls: Set<string>;
  toolCallStatuses: Map<string, "success" | "error">;
  /**
   * Assistant or reasoning text streamed so far for the current message. The
   * child emits one chunk per token batch, all with the same ID; the whole
   * message goes to the task's progress log once it ends.
   */
  pendingText?: { id: string; kind: "text" | "reasoning"; text: string };
}

/**
 * Record a tool call to the state store and the task's progress log
 */
function recordToolCall(
  subagentId: string,
  toolCallId: string,
  toolName: string,
  toolArgs: string,
  displayedToolCalls: Set<string>,
  at?: string,
): void {
  if (!toolCallId || !toolName || displayedToolCalls.has(toolCallId)) return;
  displayedToolCalls.add(toolCallId);
  addToolCall(subagentId, toolCallId, toolName, toolArgs);
  recordTaskProgressToolCall(
    subagentId,
    { id: toolCallId, name: toolName, args: toolArgs },
    at,
  );
}

function assistantChunkText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && typeof part === "object" && "text" in part
        ? String((part as { text?: unknown }).text ?? "")
        : "",
    )
    .join("");
}

/**
 * Write the assistant message streamed so far to the task's progress log.
 * Called when the message ends: another message or the result arrives, or the
 * child's stdout closes.
 */
export function flushPendingProgressText(
  state: ExecutionState,
  subagentId: string,
): void {
  const pending = state.pendingText;
  if (!pending) return;
  state.pendingText = undefined;
  recordTaskEvent(subagentId, { type: pending.kind, text: pending.text });
}

function handleTextChunk(
  event: {
    id?: string;
    otid?: string;
    content?: unknown;
    reasoning?: unknown;
    message_type?: string;
  },
  state: ExecutionState,
  subagentId: string,
): void {
  const kind =
    event.message_type === "reasoning_message" ? "reasoning" : "text";
  const id = event.id ?? event.otid ?? "";
  const text =
    kind === "reasoning"
      ? typeof event.reasoning === "string"
        ? event.reasoning
        : ""
      : assistantChunkText(event.content);
  const pending = state.pendingText;
  if (pending && (pending.id !== id || pending.kind !== kind)) {
    flushPendingProgressText(state, subagentId);
  }
  state.pendingText = {
    id,
    kind,
    text: (state.pendingText?.text ?? "") + text,
  };
}

/**
 * Handle an init event from the subagent stream
 */
function handleInitEvent(
  event: { agent_id?: string; conversation_id?: string },
  state: ExecutionState,
  subagentId: string,
): void {
  if (event.agent_id) {
    state.agentId = event.agent_id;
    const agentURL = buildAgentReference(event.agent_id, {
      conversationId: event.conversation_id,
    });
    updateSubagent(subagentId, {
      agentId: event.agent_id,
      agentURL,
      conversationId: event.conversation_id ?? null,
    });
  }
  if (event.conversation_id) {
    state.conversationId = event.conversation_id;
    if (!event.agent_id) {
      updateSubagent(subagentId, { conversationId: event.conversation_id });
    }
  }
  if (event.agent_id || event.conversation_id) {
    recordTaskEvent(
      subagentId,
      {
        type: "session",
        ...(event.agent_id ? { agent_id: event.agent_id } : {}),
        ...(event.conversation_id
          ? { conversation_id: event.conversation_id }
          : {}),
      },
      { key: `session:${event.agent_id}:${event.conversation_id}` },
    );
  }
}

/**
 * Handle a tool_call_message event. The subagent runs headless with
 * --output-format stream-json and emits a tool_call_message (with complete
 * arguments) for every tool it calls — both server-side tools and locally
 * executed ones. Record each so the subagent's tool-call list stays in sync.
 */
function handleToolCallEvent(
  event: {
    date?: string;
    tool_call?: { tool_call_id?: string; name?: string; arguments?: string };
    tool_calls?: Array<{
      tool_call_id?: string;
      name?: string;
      arguments?: string;
    }>;
  },
  state: ExecutionState,
  subagentId: string,
): void {
  const toolCalls = Array.isArray(event.tool_calls)
    ? event.tool_calls
    : event.tool_call
      ? [event.tool_call]
      : [];

  for (const tc of toolCalls) {
    const { tool_call_id, name, arguments: toolArgs = "{}" } = tc;
    if (tool_call_id && name) {
      recordToolCall(
        subagentId,
        tool_call_id,
        name,
        toolArgs,
        state.displayedToolCalls,
        typeof event.date === "string" ? event.date : undefined,
      );
    }
  }
}

interface ToolReturnFields {
  tool_call_id?: string;
  status?: string;
  tool_return?: unknown;
  func_response?: unknown;
  stdout?: unknown;
  stderr?: unknown;
}

/** A tool return's full output: its return value, else its stdout/stderr. */
function toolReturnOutput(toolReturn: ToolReturnFields): string {
  const value = toolOutputText(
    toolReturn.tool_return ?? toolReturn.func_response,
  );
  if (value) return value;
  return [toolReturn.stdout, toolReturn.stderr]
    .map((stream) => toolOutputText(stream))
    .filter(Boolean)
    .join("\n");
}

type ToolReturnEvent = ToolReturnFields & {
  date?: string;
  tool_returns?: ToolReturnFields[] | null;
};

/** Write each tool return in a `tool_return_message` to the task's logs. */
export function recordToolReturnProgress(
  event: ToolReturnEvent,
  subagentId: string,
): void {
  const returns = Array.isArray(event.tool_returns)
    ? event.tool_returns
    : [event];
  for (const toolReturn of returns) {
    if (!toolReturn.tool_call_id) continue;
    recordTaskEvent(
      subagentId,
      {
        type: "tool_result",
        tool_call_id: toolReturn.tool_call_id,
        is_error: toolReturn.status === "error",
        output: toolReturnOutput(toolReturn),
      },
      { at: typeof event.date === "string" ? event.date : undefined },
    );
  }
}

function handleToolReturnEvent(
  event: ToolReturnEvent,
  state: ExecutionState,
  subagentId: string,
): void {
  const returns = Array.isArray(event.tool_returns)
    ? event.tool_returns
    : [event];

  for (const toolReturn of returns) {
    const toolCallId = toolReturn.tool_call_id;
    if (!toolCallId) continue;
    if (toolReturn.status === "success" || toolReturn.status === "error") {
      state.toolCallStatuses.set(toolCallId, toolReturn.status);
    }
  }
  recordToolReturnProgress(event, subagentId);
}

/**
 * Handle a result event
 */
function isEnqueueReceipt(event: {
  status?: unknown;
  agent_id?: unknown;
  parent_agent_id?: unknown;
  conversation_id?: unknown;
  client_message_id?: unknown;
  super_run_id?: unknown;
  workflow_id?: unknown;
  acting_user_id?: unknown;
}): event is EnqueueReceipt {
  return (
    event.status === "queued" &&
    (typeof event.agent_id === "string" ||
      (event.agent_id === null && typeof event.parent_agent_id === "string")) &&
    (event.parent_agent_id === undefined ||
      typeof event.parent_agent_id === "string") &&
    typeof event.conversation_id === "string" &&
    typeof event.client_message_id === "string" &&
    typeof event.super_run_id === "string" &&
    typeof event.workflow_id === "string" &&
    (event.acting_user_id === undefined ||
      event.acting_user_id === null ||
      typeof event.acting_user_id === "string")
  );
}

/**
 * Error text of a failed result envelope. Cloud-routed sends emit
 * `{ result: null, error: "<text>" }`; local turns put the text in `result`.
 */
export function getResultEnvelopeError(event: {
  result?: string | null;
  error?: string | null;
}): string {
  return event.error || event.result || "Unknown error";
}

/**
 * Handle a result event
 */
function handleResultEvent(
  event: {
    subtype?: string;
    result?: string | null;
    error?: string | null;
    is_error?: boolean;
    duration_ms?: number;
    usage?: { total_tokens?: number; step_count?: number } | null;
    num_turns?: number;
    status?: unknown;
    agent_id?: unknown;
    parent_agent_id?: unknown;
    conversation_id?: unknown;
    client_message_id?: unknown;
    super_run_id?: unknown;
    workflow_id?: unknown;
    connection_id?: unknown;
    acting_user_id?: unknown;
  },
  state: ExecutionState,
  subagentId: string,
): void {
  if (event.subtype === "queued") {
    if (isEnqueueReceipt(event)) {
      state.enqueueReceipt = {
        status: "queued",
        agent_id: event.agent_id,
        ...(event.parent_agent_id
          ? { parent_agent_id: event.parent_agent_id }
          : {}),
        conversation_id: event.conversation_id,
        client_message_id: event.client_message_id,
        super_run_id: event.super_run_id,
        workflow_id: event.workflow_id,
        ...(typeof event.connection_id === "string"
          ? { connection_id: event.connection_id }
          : {}),
        ...(event.acting_user_id === undefined
          ? {}
          : { acting_user_id: event.acting_user_id }),
      };
    } else {
      state.finalError =
        "Subagent reported a queued remote send without a complete receipt";
    }
    return;
  }
  state.finalResult = event.result || "";
  state.resultStats = {
    durationMs: event.duration_ms || 0,
    totalTokens: event.usage?.total_tokens || 0,
    stepCount:
      typeof event.usage?.step_count === "number"
        ? event.usage.step_count
        : undefined,
  };

  if (event.is_error) {
    state.finalError = getResultEnvelopeError(event);
  }

  // Update state store with final stats
  updateSubagent(subagentId, {
    totalTokens: state.resultStats.totalTokens,
    durationMs: state.resultStats.durationMs,
  });
}

/**
 * Process a single JSON event from the subagent stream
 */
export function processStreamEvent(
  line: string,
  state: ExecutionState,
  subagentId: string,
): void {
  try {
    const event = JSON.parse(line);

    switch (event.type) {
      case "init":
      case "system":
        // Handle both legacy "init" type and new "system" type with subtype "init"
        if (event.type === "init" || event.subtype === "init") {
          handleInitEvent(event, state, subagentId);
        }
        break;

      case "message":
        // Record tool calls and assistant text so the subagent's tool-call
        // list and the task's output file stay in sync, then forward the
        // message for WS streaming to the web UI.
        if (
          event.message_type === "assistant_message" ||
          event.message_type === "reasoning_message"
        ) {
          handleTextChunk(event, state, subagentId);
        } else if (event.message_type !== "usage_statistics") {
          flushPendingProgressText(state, subagentId);
        }
        if (event.message_type === "tool_call_message") {
          handleToolCallEvent(event, state, subagentId);
        }
        if (event.message_type === "tool_return_message") {
          handleToolReturnEvent(event, state, subagentId);
        }
        emitStreamEvent(subagentId, event);
        break;

      case "result":
        flushPendingProgressText(state, subagentId);
        handleResultEvent(event, state, subagentId);
        break;

      case "error":
        flushPendingProgressText(state, subagentId);
        state.finalError = event.error || event.message || "Unknown error";
        break;
    }
  } catch {
    // Not valid JSON, ignore
  }
}

/** Whether at least one identified tool call reached a successful terminal state. */
export function hasSuccessfulToolCall(state: ExecutionState): boolean {
  for (const toolCallId of state.displayedToolCalls) {
    if (state.toolCallStatuses.get(toolCallId) === "success") {
      return true;
    }
  }
  return false;
}

/**
 * Whether a subagent's stream-json stdout ends mid-line: the final segment has
 * no line terminator and is non-empty but not valid JSON. A healthy stream ends
 * with a complete result envelope, so a partial trailing line is unambiguous
 * evidence the tail was truncated in transit (#3257). Complete-but-unexpected
 * output (the final line parses, has a terminator, or stdout is empty) is NOT
 * treated as truncation — the child may have already performed side effects,
 * so callers only retry the clear case.
 */
export function looksLikeTruncatedStreamJson(stdout: string): boolean {
  const lines = stdout.split(/\r?\n/);
  const lastLine = (lines[lines.length - 1] ?? "").trim();
  if (lastLine.length === 0) return false;
  try {
    JSON.parse(lastLine);
    return false;
  } catch {
    return true;
  }
}

/**
 * Parse the final result from stdout if not captured during streaming
 */
export function parseResultFromStdout(
  stdout: string,
  agentId: string | null,
): SubagentResult {
  const lines = stdout.trim().split("\n");
  const lastLine = lines[lines.length - 1] ?? "";

  if (stdout.trim().length === 0) {
    debugWarn(
      "subagent",
      `parseResultFromStdout: stdout is empty (agentId=${agentId})`,
    );
  }

  try {
    const result = JSON.parse(lastLine);

    if (result.type === "result") {
      return {
        agentId: agentId || "",
        report: result.result || "",
        success: !result.is_error,
        error: result.is_error ? getResultEnvelopeError(result) : undefined,
        stepCount:
          typeof result.usage?.step_count === "number"
            ? result.usage.step_count
            : undefined,
        durationMs:
          typeof result.duration_ms === "number"
            ? result.duration_ms
            : undefined,
      };
    }

    debugWarn(
      "subagent",
      `parseResultFromStdout: last line parsed as JSON but type=${result.type}, not "result" (agentId=${agentId})`,
    );
    return {
      agentId: agentId || "",
      report: "",
      success: false,
      error: "Unexpected output format from subagent",
    };
  } catch (parseError) {
    debugWarn(
      "subagent",
      `parseResultFromStdout: JSON.parse failed on last line (${lastLine.length} chars): ${getErrorMessage(parseError)}. ` +
        `Total stdout: ${stdout.length} chars, ${lines.length} lines. Last line: ${lastLine.slice(0, 200)}`,
    );
    return {
      agentId: agentId || "",
      report: "",
      success: false,
      error: `Failed to parse subagent output: ${getErrorMessage(parseError)}`,
    };
  }
}

const STDERR_TAIL_CHARS = 2_000;

/**
 * Error text for a child that exited without delivering a result envelope.
 * Names the exit code or signal first; the stderr tail is supporting detail,
 * because on a normal startup it holds only progress logging.
 */
export function describeSubagentExit(
  exitCode: number | null,
  exitSignal: NodeJS.Signals | null,
  stderr: string,
): string {
  const how =
    exitSignal !== null
      ? `was killed by ${exitSignal}`
      : `exited with code ${exitCode ?? "unknown"}`;
  const head = `Subagent process ${how} before returning a result`;
  const trimmed = stderr.trim();
  if (!trimmed) return `${head}.`;
  const tail =
    trimmed.length > STDERR_TAIL_CHARS
      ? `…${trimmed.slice(-STDERR_TAIL_CHARS)}`
      : trimmed;
  return `${head}. stderr tail:\n${tail}`;
}
