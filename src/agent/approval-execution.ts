// src/agent/approval-execution.ts
// Shared logic for executing approval batches (used by both interactive and headless modes)

import type Letta from "@letta-ai/letta-client";
import type {
  ApprovalCreate,
  ToolReturn,
} from "@letta-ai/letta-client/resources/agents/messages";
import type { ToolReturnMessage } from "@letta-ai/letta-client/resources/tools";
import type { ApprovalRequest } from "../cli/helpers/stream";
import { executeTool } from "../tools/manager";

export type ApprovalDecision =
  | { type: "approve"; approval: ApprovalRequest }
  | { type: "deny"; approval: ApprovalRequest; reason: string };

// Align result type with the SDK's expected union for approvals payloads
export type ApprovalResult = ToolReturn | ApprovalCreate.ApprovalReturn;

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
  agentId?: string,
  client?: Letta,
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

        if (
          decision.approval.toolName === "update_plan" &&
          agentId &&
          client
        ) {
          await savePlanToMemory(client, agentId, parsedArgs);
        }

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

async function savePlanToMemory(
  client: Letta,
  agentId: string,
  args: Record<string, unknown>,
): Promise<void> {
  const planItems = Array.isArray(args.plan) ? (args.plan as unknown[]) : [];
  if (planItems.length === 0) {
    return;
  }

  const explanation =
    typeof args.explanation === "string" && args.explanation.trim().length > 0
      ? args.explanation.trim()
      : null;

  const lines: string[] = [];

  if (explanation) {
    lines.push("Explanation:", explanation, "");
  }

  lines.push("Plan:");

  let index = 1;
  for (const rawItem of planItems) {
    if (
      !rawItem ||
      typeof rawItem !== "object" ||
      !("step" in rawItem) ||
      !("status" in rawItem)
    ) {
      continue;
    }
    const item = rawItem as { step?: unknown; status?: unknown };
    const step =
      typeof item.step === "string" && item.step.trim().length > 0
        ? item.step.trim()
        : null;
    const status =
      typeof item.status === "string" && item.status.trim().length > 0
        ? item.status.trim()
        : "pending";

    if (!step) continue;

    lines.push(`${index}. [${status}] ${step}`);
    index += 1;
  }

  if (index === 1) {
    // No valid items
    return;
  }

  const value = lines.join("\n");

  await client.agents.blocks.modify("plan", {
    agent_id: agentId,
    value,
    description: "Structured task plan recorded via update_plan",
  });
}

