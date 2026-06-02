import type { ReflectionSettings } from "@/cli/helpers/memory-reminder";

export function formatReflectionSettings(settings: ReflectionSettings): string {
  if (settings.trigger === "off") {
    return "Off";
  }
  if (settings.trigger === "compaction-event") {
    return "Compaction event";
  }
  return `Step count (every ${settings.stepCount} turns)`;
}
