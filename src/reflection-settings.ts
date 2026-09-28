export type ReflectionTrigger = "off" | "step-count" | "compaction-event";

export type ReflectionMergeMode = "auto" | "explicit";

/** Host policy, independent of saved trigger settings. Manual reflection is unaffected. */
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
