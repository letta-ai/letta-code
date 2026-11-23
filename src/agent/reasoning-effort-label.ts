import { models } from "@/agent/model-catalog";

export function catalogHasDistinctMaxTier(params: {
  modelLabel?: string;
  modelHandle?: string;
}): boolean {
  const { modelLabel, modelHandle } = params;
  if (!modelLabel && !modelHandle) return false;

  return models.some((model) => {
    if (model.updateArgs?.reasoning_effort !== "max") return false;
    if (modelHandle && model.handle === modelHandle) return true;
    return Boolean(modelLabel && model.label === modelLabel);
  });
}

export function formatXhighEffortLabel(hasDistinctMaxTier: boolean): string {
  return hasDistinctMaxTier ? "Extra High" : "Max";
}
