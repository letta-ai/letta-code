import { getSubagents } from "@/agent/subagent-state";
import type { ReflectionSettings } from "@/cli/helpers/memory-reminder";
import { isReflectionSubagentActive } from "@/cli/helpers/reflection-gate";

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
