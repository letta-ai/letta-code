/**
 * Stream-json wire events for LOCALLY-executed tools.
 *
 * The Letta server only streams `tool_call_message` / `tool_return_message`
 * for tools it runs itself (e.g. `web_search`, `fetch_webpage`). Tools executed
 * client-side by the CLI — Bash, Read, Edit, Write, Grep, … — run through
 * `executeApprovalBatch`, and their results are fed back to the server as the
 * next request's input. They never appear on the server stream, so a stream-json
 * consumer sees the `auto_approval` call hint but never the tool's output.
 *
 * These emitters give local tools the same `tool_call_message` → `tool_return_message`
 * pairing (keyed by `tool_call_id`) that server-side tools already get on the wire,
 * so downstream consumers can pair calls with returns uniformly regardless of where
 * the tool executed.
 */

import type { ApprovalResult } from "@/agent/approval-execution";
import { getDisplayableToolReturn } from "@/agent/approval-execution";
import { writeWireMessage } from "./stream-json-writer";
import type {
  ToolCallMessageWire,
  ToolReturnMessageWire,
} from "./types/protocol";

/** Minimal shape shared by the `Decision` unions at both headless call sites. */
interface LocalToolDecision {
  approval: {
    toolCallId: string;
    toolName: string;
    toolArgs: string;
  };
}

/**
 * Emit a normalized `tool_call_message` for each locally-executed tool decision.
 * Call this immediately before `executeApprovalBatch` so the call is observed on
 * the wire before its (awaited) result.
 */
export function emitLocalToolCalls(
  decisions: LocalToolDecision[],
  sessionId: string,
): void {
  const date = new Date().toISOString();
  for (const decision of decisions) {
    const { toolCallId, toolName, toolArgs } = decision.approval;
    const msg: ToolCallMessageWire = {
      type: "message",
      message_type: "tool_call_message",
      id: `tool-call-${toolCallId}`,
      date,
      tool_call: {
        name: toolName,
        tool_call_id: toolCallId,
        arguments: toolArgs || "{}",
      },
      session_id: sessionId,
      uuid: `tool-call-${toolCallId}`,
    };
    writeWireMessage(msg);
  }
}

/**
 * Emit a `tool_return_message` for each locally-executed tool result. Results
 * that carry no tool output (approval-only entries) are skipped.
 */
export function emitLocalToolReturns(
  results: ApprovalResult[],
  sessionId: string,
): void {
  const date = new Date().toISOString();
  for (const result of results) {
    // ApprovalReturn entries carry an approval decision, not tool output.
    if (!("tool_return" in result)) continue;
    const msg: ToolReturnMessageWire = {
      type: "message",
      message_type: "tool_return_message",
      id: `tool-return-${result.tool_call_id}`,
      date,
      status: result.status,
      tool_call_id: result.tool_call_id,
      tool_return: getDisplayableToolReturn(result.tool_return),
      stdout: result.stdout,
      stderr: result.stderr,
      session_id: sessionId,
      uuid: `tool-return-${result.tool_call_id}`,
    };
    writeWireMessage(msg);
  }
}
