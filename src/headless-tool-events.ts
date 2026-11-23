import type { ApprovalResult } from "@/agent/approval-execution";
import { getDisplayableToolReturn } from "@/agent/approval-execution";
import { writeWireMessage } from "./stream-json-writer";
import type {
  ToolCallMessageWire,
  ToolReturnMessageWire,
} from "./types/protocol";

interface LocalToolDecision {
  approval: {
    toolCallId: string;
    toolName: string;
    toolArgs: string;
  };
}

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

export function emitLocalToolReturns(
  results: ApprovalResult[],
  sessionId: string,
): void {
  const date = new Date().toISOString();
  for (const result of results) {
    const isToolResult = "tool_return" in result;
    const msg: ToolReturnMessageWire = {
      type: "message",
      message_type: "tool_return_message",
      id: `tool-return-${result.tool_call_id}`,
      date,
      status: isToolResult ? result.status : "error",
      tool_call_id: result.tool_call_id,
      tool_return: isToolResult
        ? getDisplayableToolReturn(result.tool_return)
        : `Error: request to call tool denied. User reason: ${result.reason ?? "Denied"}`,
      ...(isToolResult
        ? {
            stdout: result.stdout,
            stderr: result.stderr,
          }
        : {}),
      session_id: sessionId,
      uuid: `tool-return-${result.tool_call_id}`,
    };
    writeWireMessage(msg);
  }
}
