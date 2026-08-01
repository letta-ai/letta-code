import type { ReflectionSettings } from "@/cli/helpers/memory-reminder";

export function formatReflectionSettings(settings: ReflectionSettings): string {
  const merge =
    settings.merge === "explicit" ? "explicit integration" : "auto-merge";
  if (settings.trigger === "off") {
    return `Off, ${merge}`;
  }
  if (settings.trigger === "compaction-event") {
    return `Compaction event, ${merge}`;
  }
  return `Step count (every ${settings.stepCount} turns), ${merge}`;
}
