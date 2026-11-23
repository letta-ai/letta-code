export type ReflectionTrigger = "off" | "step-count" | "compaction-event";

export type ReflectionMergeMode = "auto" | "explicit";

export function isAutoReflectionEnabled(): boolean {
  return (
    process.platform !== "win32" ||
    process.env.LETTA_ENABLE_WINDOWS_AUTO_REFLECTION === "1"
  );
}

export interface StoredReflectionSettings {
  trigger: ReflectionTrigger;
  stepCount: number;
  merge?: ReflectionMergeMode;
  mergeInstructions?: string;
}
