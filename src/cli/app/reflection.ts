import { getSubagents } from "@/agent/subagentState";
import type { ReflectionSettings } from "@/cli/helpers/memoryReminder";
import { isReflectionSubagentActive } from "@/cli/helpers/reflectionGate";

export function formatReflectionSettings(settings: ReflectionSettings): string {
  if (settings.trigger === "off") {
    return "Off";
  }
  if (settings.trigger === "compaction-event") {
    return "Compaction event";
  }
  return `Step count (every ${settings.stepCount} turns)`;
}

export function hasActiveReflectionSubagent(
  agentId: string,
  conversationId: string,
): boolean {
  return isReflectionSubagentActive(getSubagents(), agentId, conversationId);
}
