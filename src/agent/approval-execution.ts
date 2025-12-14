// src/agent/approval-execution.ts
// Shared logic for executing approval batches (used by both interactive and headless modes)
import type {
  ApprovalReturn,
  ToolReturn,
} from "@letta-ai/letta-client/resources/agents/messages";
import type { ToolReturnMessage } from "@letta-ai/letta-client/resources/tools";
import type { ApprovalRequest } from "../cli/helpers/stream";
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
 * Execute a batch of approval decisions and format results for the backend.
 *
 * This function handles:
 * - Executing approved tools (with error handling)
 * - Formatting denials
 * - Combining all results into a single batch
 *
 * Used by both interactive (App.tsx) and headless (headless.ts) modes.
 *
 * @param decisions - Array of approve/deny decisions for each tool
 * @param onChunk - Optional callback to update UI with tool results (for interactive mode)
 * @returns Array of formatted results ready to send to backend
 */
export async function executeApprovalBatch(
  decisions: ApprovalDecision[],
  onChunk?: (chunk: ToolReturnMessage) => void,
  options?: { abortSignal?: AbortSignal },
): Promise<ApprovalResult[]> {
  const results: ApprovalResult[] = [];

  for (const decision of decisions) {
    // If aborted before starting this decision, record an interrupted result
    if (options?.abortSignal?.aborted) {
      // Emit an interrupted chunk for visibility if callback provided
      if (onChunk) {
        onChunk({
          message_type: "tool_return_message",
          id: "dummy",
          date: new Date().toISOString(),
          tool_call_id: decision.approval.toolCallId,
          tool_return: "User interrupted tool execution",
          status: "error",
        });
      }

      results.push({
        type: "tool",
        tool_call_id: decision.approval.toolCallId,
        tool_return: "User interrupted tool execution",
        status: "error",
      });
      continue;
    }

    if (decision.type === "approve") {
      // If fancy UI already computed the result, use it directly
      if (decision.precomputedResult) {
        // Don't call onChunk - UI was already updated in the fancy UI handler
        results.push({
          type: "tool",
          tool_call_id: decision.approval.toolCallId,
          tool_return: decision.precomputedResult.toolReturn,
          status: decision.precomputedResult.status,
          stdout: decision.precomputedResult.stdout,
          stderr: decision.precomputedResult.stderr,
        });
        continue;
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

        results.push({
          type: "tool",
          tool_call_id: decision.approval.toolCallId,
          tool_return: toolResult.toolReturn,
          status: toolResult.status,
          stdout: toolResult.stdout,
          stderr: toolResult.stderr,
        });
      } catch (e) {
        const isAbortError =
          e instanceof Error &&
          (e.name === "AbortError" ||
            e.message === "The operation was aborted");
        const errorMessage = isAbortError
          ? "User interrupted tool execution"
          : `Error executing tool: ${String(e)}`;

        // Still need to send error result to backend for this tool
        // Update UI if callback provided
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

        results.push({
          type: "tool",
          tool_call_id: decision.approval.toolCallId,
          tool_return: errorMessage,
          status: "error",
        });
      }
    } else {
      // Format denial for backend
      // Update UI if callback provided
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

      results.push({
        type: "approval",
        tool_call_id: decision.approval.toolCallId,
        approve: false,
        reason: decision.reason,
      });
    }
  }

  return results;
}
