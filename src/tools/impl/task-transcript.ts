// Output-file transcript lines and result headers shared by Agent task paths.

import type { SubagentResult } from "@/agent/subagents";
import { appendToOutputFile } from "./process_manager.js";

export function buildTaskResultHeader(
  subagentType: string,
  subagentId: string,
  result?: Pick<
    SubagentResult,
    "agentId" | "conversationId" | "runtimeSessionId"
  >,
  status?: "success" | "error",
): string {
  return [
    `subagent_type=${subagentType}`,
    `subagent_id=${subagentId}`,
    status ? `subagent_status=${status}` : undefined,
    result?.agentId ? `agent_id=${result.agentId}` : undefined,
    result?.conversationId
      ? `conversation_id=${result.conversationId}`
      : undefined,
    result?.runtimeSessionId
      ? `runtime_session_id=${result.runtimeSessionId}`
      : undefined,
  ]
    .filter(Boolean)
    .join(" ");
}

export function writeTaskTranscriptStart(
  outputFile: string,
  description: string,
  subagentType: string,
): void {
  appendToOutputFile(
    outputFile,
    `[Task started: ${description}]\n[subagent_type: ${subagentType}]\n\n`,
  );
}

export function writeTaskTranscriptResult(
  outputFile: string,
  result: SubagentResult,
  header: string,
  reportAlreadyWritten = false,
): void {
  if (result.success) {
    const report = reportAlreadyWritten ? "" : `${result.report}\n\n`;
    appendToOutputFile(outputFile, `${header}\n\n${report}[Task completed]\n`);
    return;
  }

  appendToOutputFile(
    outputFile,
    `${header ? `${header}\n\n` : ""}[error] ${result.error || "Subagent execution failed"}\n\n[Task failed]\n`,
  );
}
