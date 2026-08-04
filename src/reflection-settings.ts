export type ReflectionTrigger = "off" | "step-count" | "compaction-event";

export type ReflectionMergeMode = "auto" | "explicit";

export interface StoredReflectionSettings {
  trigger: ReflectionTrigger;
  stepCount: number;
  merge?: ReflectionMergeMode;
  mergeInstructions?: string;
}
