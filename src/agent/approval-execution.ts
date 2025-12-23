// src/agent/approval-execution.ts
// Shared logic for executing approval batches (used by both interactive and headless modes)
import type {
  ApprovalReturn,
  ToolReturn,
} from "@letta-ai/letta-client/resources/agents/messages";
import type { ToolReturnMessage } from "@letta-ai/letta-client/resources/tools";
import type { ApprovalRequest } from "../cli/helpers/stream";
import { INTERRUPTED_BY_USER } from "../constants";
import { executeTool, type ToolExecutionResult } from "../tools/manager";

/**
 * Tools that are safe to execute in parallel (read-only or independent).
 * These tools don't modify files or shared state, so they can't race with each other.
 * Note: Bash is intentionally excluded - it can run arbitrary commands that may write files.
 */
const PARALLEL_SAFE_TOOLS = new Set([
  // Read-only file tools
  "Read",
  "Grep",
  "Glob",
  // Search/fetch tools (external APIs or read-only queries)
  "conversation_search",
  "web_search",
  "fetch_webpage",
  // Background shell output (read-only check)
  "BashOutput",
  // Task spawns independent subagents
  "Task",
]);

function isParallelSafe(toolName: string): boolean {
  return PARALLEL_SAFE_TOOLS.has(toolName);
}

/** Result format expected by App.tsx for auto-allowed tools */
export type AutoAllowedResult = {
  toolCallId: string;
  result: ToolExecutionResult;
};

export type ApprovalDecision =
  | {
      type: "approve";
      approval: ApprovalRequest;
      // If set, skip executeTool and use this result (for fancy UI tools)
      precomputedResult?: ToolExecutionResult;
    }
  | { type: "deny"; approval: ApprovalRequest; reason: string };

// Align result type with the SDK's expected union for approvals payloads
export type ApprovalResult = ToolReturn | ApprovalReturn;

/**
 * Execute a single approval decision and return the result.
 * Extracted to allow parallel execution of Task tools.
 */
async function executeSingleDecision(
  decision: ApprovalDecision,
  onChunk?: (chunk: ToolReturnMessage) => void,
  options?: { abortSignal?: AbortSignal },
): Promise<ApprovalResult> {
  // If aborted, record an interrupted result
  if (options?.abortSignal?.aborted) {
    if (onChunk) {
      onChunk({
        message_type: "tool_return_message",
        id: "dummy",
        date: new Date().toISOString(),
        tool_call_id: decision.approval.toolCallId,
        tool_return: INTERRUPTED_BY_USER,
        status: "error",
      });
    }
    return {
      type: "tool",
      tool_call_id: decision.approval.toolCallId,
      tool_return: INTERRUPTED_BY_USER,
      status: "error",
    };
  }

  if (decision.type === "approve") {
    // If fancy UI already computed the result, use it directly
    if (decision.precomputedResult) {
      return {
        type: "tool",
        tool_call_id: decision.approval.toolCallId,
        tool_return: decision.precomputedResult.toolReturn,
        status: decision.precomputedResult.status,
        stdout: decision.precomputedResult.stdout,
        stderr: decision.precomputedResult.stderr,
      };
    }

    // Execute the approved tool
    try {
      const parsedArgs =
        typeof decision.approval.toolArgs === "string"
          ? JSON.parse(decision.approval.toolArgs)
          : decision.approval.toolArgs || {};

      const toolResult = await executeTool(
        decision.approval.toolName,
        parsedArgs,
        {
          signal: options?.abortSignal,
          toolCallId: decision.approval.toolCallId,
        },
      );

      // Update UI if callback provided (interactive mode)
      if (onChunk) {
        onChunk({
          message_type: "tool_return_message",
          id: "dummy",
          date: new Date().toISOString(),
          tool_call_id: decision.approval.toolCallId,
          tool_return: toolResult.toolReturn,
          status: toolResult.status,
          stdout: toolResult.stdout,
          stderr: toolResult.stderr,
        });
      }

      return {
        type: "tool",
        tool_call_id: decision.approval.toolCallId,
        tool_return: toolResult.toolReturn,
        status: toolResult.status,
        stdout: toolResult.stdout,
        stderr: toolResult.stderr,
      };
    } catch (e) {
      const isAbortError =
        e instanceof Error &&
        (e.name === "AbortError" || e.message === "The operation was aborted");
      const errorMessage = isAbortError
        ? INTERRUPTED_BY_USER
        : `Error executing tool: ${String(e)}`;

      if (onChunk) {
        onChunk({
          message_type: "tool_return_message",
          id: "dummy",
          date: new Date().toISOString(),
          tool_call_id: decision.approval.toolCallId,
          tool_return: errorMessage,
          status: "error",
        });
      }

      return {
        type: "tool",
        tool_call_id: decision.approval.toolCallId,
        tool_return: errorMessage,
        status: "error",
      };
    }
  }

  // Format denial for backend
  if (onChunk) {
    onChunk({
      message_type: "tool_return_message",
      id: "dummy",
      date: new Date().toISOString(),
      tool_call_id: decision.approval.toolCallId,
      tool_return: `Error: request to call tool denied. User reason: ${decision.reason}`,
      status: "error",
    });
  }

  return {
    type: "approval",
    tool_call_id: decision.approval.toolCallId,
    approve: false,
    reason: decision.reason,
  };
}

/**
 * Execute a batch of approval decisions and format results for the backend.
 *
 * This function handles:
 * - Executing approved tools (with error handling)
 * - Formatting denials
 * - Combining all results into a single batch
 * - Parallel-safe tools (read-only + Task) are executed in parallel for performance
 * - Write/stateful tools (Edit, Write, Bash, etc.) are executed sequentially to avoid race conditions
 *
 * Used by both interactive (App.tsx) and headless (headless.ts) modes.
 *
 * @param decisions - Array of approve/deny decisions for each tool
 * @param onChunk - Optional callback to update UI with tool results (for interactive mode)
 * @returns Array of formatted results ready to send to backend (maintains original order)
 */
export async function executeApprovalBatch(
  decisions: ApprovalDecision[],
  onChunk?: (chunk: ToolReturnMessage) => void,
  options?: { abortSignal?: AbortSignal },
): Promise<ApprovalResult[]> {
  // Pre-allocate results array to maintain original order
  const results: (ApprovalResult | null)[] = new Array(decisions.length).fill(
    null,
  );

  // Identify parallel-safe tools (read-only + Task)
  const parallelIndices: number[] = [];
  for (let i = 0; i < decisions.length; i++) {
    const decision = decisions[i];
    if (
      decision &&
      decision.type === "approve" &&
      isParallelSafe(decision.approval.toolName)
    ) {
      parallelIndices.push(i);
    }
  }

  // Execute write/stateful tools sequentially to avoid race conditions
  for (let i = 0; i < decisions.length; i++) {
    const decision = decisions[i];
    if (!decision || parallelIndices.includes(i)) continue;
    results[i] = await executeSingleDecision(decision, onChunk, options);
  }

  // Execute parallel-safe tools (read-only + Task) in parallel
  if (parallelIndices.length > 0) {
    const parallelDecisions = parallelIndices
      .map((i) => decisions[i])
      .filter((d): d is ApprovalDecision => d !== undefined);
    const parallelResults = await Promise.all(
      parallelDecisions.map((decision) =>
        executeSingleDecision(decision, onChunk, options),
      ),
    );

    // Place parallel results in original positions
    for (let j = 0; j < parallelIndices.length; j++) {
      const idx = parallelIndices[j];
      const result = parallelResults[j];
      if (idx !== undefined && result !== undefined) {
        results[idx] = result;
      }
    }
  }

  // Filter out nulls (shouldn't happen, but TypeScript needs this)
  return results.filter((r): r is ApprovalResult => r !== null);
}

/**
 * Helper to execute auto-allowed tools and map results to the format expected by App.tsx.
 * Consolidates the common pattern of converting approvals to decisions, executing them,
 * and mapping the results back.
 *
 * @param autoAllowed - Array of auto-allowed approval contexts (must have .approval property)
 * @param onChunk - Callback to update UI with tool results
 * @param options - Optional abort signal for cancellation
 * @returns Array of results with toolCallId and ToolExecutionResult
 */
export async function executeAutoAllowedTools(
  autoAllowed: Array<{ approval: ApprovalRequest }>,
  onChunk: (chunk: ToolReturnMessage) => void,
  options?: { abortSignal?: AbortSignal },
): Promise<AutoAllowedResult[]> {
  const decisions: ApprovalDecision[] = autoAllowed.map((ac) => ({
    type: "approve" as const,
    approval: ac.approval,
  }));

  const batchResults = await executeApprovalBatch(decisions, onChunk, options);

  return batchResults
    .filter((r): r is ApprovalResult & { type: "tool" } => r.type === "tool")
    .map((r) => ({
      toolCallId: r.tool_call_id,
      result: {
        toolReturn: r.tool_return,
        status: r.status,
        stdout: r.stdout,
        stderr: r.stderr,
      } as ToolExecutionResult,
    }));
}
