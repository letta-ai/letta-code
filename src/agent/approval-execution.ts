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
 * - Task tools are executed in parallel for better performance
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

  // Identify Task tools for parallel execution
  const taskIndices: number[] = [];
  for (let i = 0; i < decisions.length; i++) {
    const decision = decisions[i];
    if (
      decision &&
      decision.type === "approve" &&
      decision.approval.toolName === "Task"
    ) {
      taskIndices.push(i);
    }
  }

  // Execute non-Task tools sequentially (existing behavior)
  for (let i = 0; i < decisions.length; i++) {
    const decision = decisions[i];
    if (!decision || taskIndices.includes(i)) continue; // Skip Task tools for now
    results[i] = await executeSingleDecision(decision, onChunk, options);
  }

  // Execute Task tools in parallel
  if (taskIndices.length > 0) {
    const taskDecisions = taskIndices
      .map((i) => decisions[i])
      .filter((d): d is ApprovalDecision => d !== undefined);
    const taskResults = await Promise.all(
      taskDecisions.map((decision) =>
        executeSingleDecision(decision, onChunk, options),
      ),
    );

    // Place Task results in original positions
    for (let j = 0; j < taskIndices.length; j++) {
      const idx = taskIndices[j];
      const result = taskResults[j];
      if (idx !== undefined && result !== undefined) {
        results[idx] = result;
      }
    }
  }

  // Filter out nulls (shouldn't happen, but TypeScript needs this)
  return results.filter((r): r is ApprovalResult => r !== null);
}
