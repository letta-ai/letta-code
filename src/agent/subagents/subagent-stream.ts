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
import { buildAgentReference } from "@/cli/helpers/app-urls";
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
  resultStats: {
    durationMs: number;
    totalTokens: number;
    stepCount?: number;
  } | null;
  displayedToolCalls: Set<string>;
}

/**
 * Record a tool call to the state store
 */
function recordToolCall(
  subagentId: string,
  toolCallId: string,
  toolName: string,
  toolArgs: string,
  displayedToolCalls: Set<string>,
): void {
  if (!toolCallId || !toolName || displayedToolCalls.has(toolCallId)) return;
  displayedToolCalls.add(toolCallId);
  addToolCall(subagentId, toolCallId, toolName, toolArgs);
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
    updateSubagent(subagentId, { agentId: event.agent_id, agentURL });
  }
  if (event.conversation_id) {
    state.conversationId = event.conversation_id;
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
      );
    }
  }
}

/**
 * Handle a result event
 */
function handleResultEvent(
  event: {
    result?: string;
    is_error?: boolean;
    duration_ms?: number;
    usage?: { total_tokens?: number; step_count?: number };
    num_turns?: number;
  },
  state: ExecutionState,
  subagentId: string,
): void {
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
    state.finalError = event.result || "Unknown error";
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
        // Record tool calls so the subagent's tool-call list stays in sync,
        // then forward the message for WS streaming to the web UI.
        if (event.message_type === "tool_call_message") {
          handleToolCallEvent(event, state, subagentId);
        }
        emitStreamEvent(subagentId, event);
        break;

      case "result":
        handleResultEvent(event, state, subagentId);
        break;

      case "error":
        state.finalError = event.error || event.message || "Unknown error";
        break;
    }
  } catch {
    // Not valid JSON, ignore
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
        error: result.is_error ? result.result || "Unknown error" : undefined,
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
