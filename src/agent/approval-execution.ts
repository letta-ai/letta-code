// src/agent/approval-execution.ts
// Shared logic for executing approval batches (used by both interactive and headless modes)

import type { ApprovalRequest } from "../cli/helpers/stream";
import { executeTool } from "../tools/manager";

export type ApprovalDecision =
  | { type: "approve"; approval: ApprovalRequest }
  | { type: "deny"; approval: ApprovalRequest; reason: string };

export type ApprovalResult = {
  type: "tool" | "approval";
  tool_call_id: string;
  tool_return?: string;
  status?: "success" | "error";
  stdout?: string[];
  stderr?: string[];
  approve?: boolean;
  reason?: string;
};

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
  onChunk?: (chunk: any) => void,
): Promise<ApprovalResult[]> {
  const results: ApprovalResult[] = [];

  for (const decision of decisions) {
    if (decision.type === "approve") {
      // Execute the approved tool
      try {
        const parsedArgs =
          typeof decision.approval.toolArgs === "string"
            ? JSON.parse(decision.approval.toolArgs)
            : decision.approval.toolArgs || {};

        const toolResult = await executeTool(
          decision.approval.toolName,
          parsedArgs,
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
        // Still need to send error result to backend for this tool
        const errorMessage = `Error executing tool: ${String(e)}`;

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
