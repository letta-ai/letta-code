import { isRecord } from "@/utils/type-guards";

/**
 * Applies a reasoning-only change to the current model_settings. The server
 * replaces model_settings as a whole, so every other current setting is kept
 * and re-sent; only the reasoning fields come from `reasoningSettings` (as
 * built by buildModelSettings). Thinking fields merge, so the current budget
 * is kept; an effort field the new level leaves unset is dropped.
 */
export function withReasoningSettings(
  current: object,
  reasoningSettings: object,
): Record<string, unknown> {
  const settings: Record<string, unknown> = { ...current };
  const next = reasoningSettings as Record<string, unknown>;
  for (const key of [
    "reasoning",
    "reasoning_effort",
    "effort",
    "thinking",
    "thinking_config",
  ]) {
    if (!(key in next)) {
      if (!key.startsWith("thinking")) delete settings[key];
      continue;
    }
    const value = next[key];
    settings[key] =
      isRecord(settings[key]) && isRecord(value)
        ? { ...settings[key], ...value }
        : value;
  }
  return settings;
}
