import {
  getReflectionSettings,
  persistReflectionSettingsForAgent,
  type ReflectionSettings,
  type ReflectionTrigger,
} from "@/cli/helpers/memory-reminder";
import { settingsManager } from "@/settings-manager";

export interface ReflectionOverrides {
  trigger?: ReflectionTrigger;
  stepCount?: number;
}

export async function applyHeadlessReflectionOverrides(
  agentId: string,
  overrides: ReflectionOverrides,
): Promise<ReflectionSettings> {
  const current = getReflectionSettings(agentId);
  const merged: ReflectionSettings = {
    ...current,
    trigger: overrides.trigger ?? current.trigger,
    stepCount: overrides.stepCount ?? current.stepCount,
  };
  if (overrides.trigger === undefined && overrides.stepCount === undefined) {
    return merged;
  }
  if (!settingsManager.isMemfsEnabled(agentId) && merged.trigger !== "off") {
    throw new Error(
      `--reflection-trigger ${merged.trigger} requires memfs enabled for this agent.`,
    );
  }
  try {
    settingsManager.getLocalProjectSettings();
  } catch {
    await settingsManager.loadLocalProjectSettings();
  }
  await persistReflectionSettingsForAgent(agentId, merged);
  return merged;
}
