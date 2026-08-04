import type { ReflectionSettings } from "@/cli/helpers/memory-reminder";

export function formatReflectionSettings(settings: ReflectionSettings): string {
  const memoryUpdates =
    settings.merge === "explicit"
      ? "agent reviews before applying"
      : "apply automatically";
  if (settings.trigger === "off") {
    return `Off, ${memoryUpdates}`;
  }
  if (settings.trigger === "compaction-event") {
    return `On compaction, ${memoryUpdates}`;
  }
  return `Every ${settings.stepCount} steps, ${memoryUpdates}`;
}
