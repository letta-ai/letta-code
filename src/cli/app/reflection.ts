import type { ReflectionSettings } from "../helpers/memoryReminder";
import { isReflectionSubagentActive } from "../helpers/reflectionGate";
import { getSubagents } from "../helpers/subagentState";

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
