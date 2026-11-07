import type { ParsedCliArgs } from "@/cli/args";
import { parsePositiveIntFlag } from "@/cli/flag-utils";
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

export function parseReflectionOverrides(
  values: ParsedCliArgs["values"],
): ReflectionOverrides {
  const triggerRaw = values["reflection-trigger"];
  const stepCountRaw = values["reflection-step-count"];
  if (!triggerRaw && !stepCountRaw) return {};
  const overrides: ReflectionOverrides = {};
  if (triggerRaw !== undefined) {
    if (
      triggerRaw !== "off" &&
      triggerRaw !== "step-count" &&
      triggerRaw !== "compaction-event"
    ) {
      throw new Error(
        `Invalid --reflection-trigger "${triggerRaw}". Valid values: off, step-count, compaction-event`,
      );
    }
    overrides.trigger = triggerRaw;
  }
  if (stepCountRaw !== undefined) {
    try {
      overrides.stepCount = parsePositiveIntFlag({
        rawValue: stepCountRaw,
        flagName: "reflection-step-count",
      });
    } catch {
      throw new Error(
        `Invalid --reflection-step-count "${stepCountRaw}". Expected a positive integer.`,
      );
    }
  }
  return overrides;
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
