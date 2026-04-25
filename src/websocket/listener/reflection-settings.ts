import {
  mergeReflectionSettingsPatch,
  normalizeReflectionSettings,
  type ReflectionSettings,
  type ReflectionSettingsPatch,
} from "../../cli/helpers/memoryReminder";
import type {
  ReflectionSettingsSnapshot,
  SetReflectionSettingsCommand,
} from "../../types/protocol_v2";

type ProtocolReflectionSettingsPatch = SetReflectionSettingsCommand["settings"];

export function reflectionSettingsPatchFromProtocol(
  settings: ProtocolReflectionSettingsPatch,
): ReflectionSettingsPatch {
  return {
    trigger: settings.trigger,
    stepCount: settings.step_count,
    activeTrigger: settings.active_trigger,
    activeStepCount: settings.active_step_count,
    passiveSweepEnabled: settings.passive_sweep_enabled,
    passiveSweepIntervalHours: settings.passive_sweep_interval_hours,
    passiveMinQuietMinutes: settings.passive_min_quiet_minutes,
    passiveMinUnreflectedTurns: settings.passive_min_unreflected_turns,
  };
}

export function mergeProtocolReflectionSettingsPatch(
  current: ReflectionSettings,
  settings: ProtocolReflectionSettingsPatch,
): ReflectionSettings {
  return mergeReflectionSettingsPatch(
    current,
    reflectionSettingsPatchFromProtocol(settings),
  );
}

export function toReflectionSettingsSnapshot(
  agentId: string,
  settings?: ReflectionSettings | null,
): ReflectionSettingsSnapshot {
  const normalized = normalizeReflectionSettings(settings ?? {});
  return {
    agent_id: agentId,
    trigger: normalized.activeTrigger,
    step_count: normalized.activeStepCount,
    active_trigger: normalized.activeTrigger,
    active_step_count: normalized.activeStepCount,
    passive_sweep_enabled: normalized.passiveSweepEnabled,
    passive_sweep_interval_hours: normalized.passiveSweepIntervalHours,
    passive_min_quiet_minutes: normalized.passiveMinQuietMinutes,
    passive_min_unreflected_turns: normalized.passiveMinUnreflectedTurns,
  };
}
