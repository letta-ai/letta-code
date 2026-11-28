import type { SubagentState, ToolCall } from "@/agent/subagent-state";
import { isRecord } from "@/utils/type-guards";

export function sessionSubagents(items: unknown[]): SubagentState[] {
  const agents: SubagentState[] = [];
  for (const item of items) {
    if (
      !isRecord(item) ||
      item.silent ||
      typeof item.subagent_id !== "string" ||
      typeof item.description !== "string"
    )
      continue;
    const { status } = item;
    if (
      status !== "pending" &&
      status !== "running" &&
      status !== "completed" &&
      status !== "error"
    )
      continue;
    const toolCalls: ToolCall[] = [];
    if (Array.isArray(item.tool_calls)) {
      for (const call of item.tool_calls) {
        if (
          isRecord(call) &&
          typeof call.id === "string" &&
          typeof call.name === "string" &&
          typeof call.args === "string"
        )
          toolCalls.push({ id: call.id, name: call.name, args: call.args });
      }
    }
    agents.push({
      id: item.subagent_id,
      description: item.description,
      status,
      toolCallId:
        typeof item.tool_call_id === "string" ? item.tool_call_id : undefined,
      type:
        typeof item.subagent_type === "string"
          ? item.subagent_type
          : "Subagent",
      agentURL: typeof item.agent_url === "string" ? item.agent_url : null,
      model: typeof item.model === "string" ? item.model : undefined,
      error: typeof item.error === "string" ? item.error : undefined,
      isBackground: item.is_background === true,
      toolCalls,
      maxToolCallsSeen: toolCalls.length,
      totalTokens:
        typeof item.total_tokens === "number" ? item.total_tokens : 0,
      durationMs: typeof item.duration_ms === "number" ? item.duration_ms : 0,
      startTime: typeof item.start_time === "number" ? item.start_time : 0,
    });
  }
  return agents;
}
