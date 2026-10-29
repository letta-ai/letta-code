import type { ConversationMessageCompactBody } from "@/backend/backend";
import { isRecord } from "@/utils/type-guards";
import {
  LOCAL_DEFAULT_COMPACTION_MODE,
  LOCAL_DEFAULT_SLIDING_WINDOW_PERCENTAGE,
  type LocalCompactionMode,
} from "./compaction";
import type { LocalAgentRecord } from "./local-store";

export type LocalCompactionSettingsRecord = Record<string, unknown>;

export interface ResolvedLocalCompactionSettings {
  mode: LocalCompactionMode;
  prompt?: string | null;
  clipChars?: number | null;
  slidingWindowPercentage: number;
}

export function compactionSettingsRecord(
  value: unknown,
): LocalCompactionSettingsRecord | null | undefined {
  if (value === null) return null;
  return isRecord(value) ? { ...value } : undefined;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(record, key);
}

const LOCAL_COMPACTION_MODES: readonly LocalCompactionMode[] = [
  "all",
  "sliding_window",
  "self_compact_all",
  "self_compact_sliding_window",
];

function localCompactionMode(value: unknown): LocalCompactionMode | undefined {
  return LOCAL_COMPACTION_MODES.find((mode) => mode === value);
}

export function validateLocalCompactionSettingsRecord(
  settings: LocalCompactionSettingsRecord,
): void {
  if (settings.mode === undefined || settings.mode === null) return;
  if (!localCompactionMode(settings.mode)) {
    throw new Error(
      `Local backend compaction supports modes ${LOCAL_COMPACTION_MODES.map((mode) => `"${mode}"`).join(", ")} (received "${String(
        settings.mode,
      )}").`,
    );
  }
}

export function localCompactionSettingsForStorage(
  settings: LocalCompactionSettingsRecord | null | undefined,
): LocalCompactionSettingsRecord | null | undefined {
  if (settings === undefined || settings === null) return settings;

  const hasLocalSetting =
    hasOwn(settings, "mode") ||
    hasOwn(settings, "prompt") ||
    hasOwn(settings, "clip_chars") ||
    hasOwn(settings, "sliding_window_percentage");
  if (!hasLocalSetting) return undefined;

  return { ...settings };
}

export function resolveLocalCompactionSettings(
  agent: LocalAgentRecord,
  body?: ConversationMessageCompactBody,
): ResolvedLocalCompactionSettings {
  const bodyRecord = (body ?? {}) as Record<string, unknown>;
  const requestSettings = compactionSettingsRecord(
    bodyRecord.compaction_settings,
  );
  if (requestSettings !== undefined && requestSettings !== null) {
    validateLocalCompactionSettingsRecord(requestSettings);
  }
  const agentSettings = compactionSettingsRecord(agent.compaction_settings);
  const baseSettings =
    agentSettings && agentSettings !== null ? agentSettings : {};
  const mergedSettings =
    requestSettings && requestSettings !== null
      ? { ...baseSettings, ...requestSettings }
      : baseSettings;
  const requestChangedMode =
    requestSettings !== undefined &&
    requestSettings !== null &&
    hasOwn(requestSettings, "mode");
  const requestChangedPrompt =
    requestSettings !== undefined &&
    requestSettings !== null &&
    hasOwn(requestSettings, "prompt");
  if (
    requestChangedMode &&
    !requestChangedPrompt &&
    agentSettings &&
    agentSettings !== null &&
    agentSettings.mode !== requestSettings.mode
  ) {
    delete mergedSettings.prompt;
  }

  const mode =
    localCompactionMode(mergedSettings.mode) ?? LOCAL_DEFAULT_COMPACTION_MODE;
  return {
    mode,
    prompt:
      typeof mergedSettings.prompt === "string" ||
      mergedSettings.prompt === null
        ? mergedSettings.prompt
        : undefined,
    clipChars:
      typeof mergedSettings.clip_chars === "number" ||
      mergedSettings.clip_chars === null
        ? mergedSettings.clip_chars
        : undefined,
    slidingWindowPercentage:
      typeof mergedSettings.sliding_window_percentage === "number"
        ? mergedSettings.sliding_window_percentage
        : LOCAL_DEFAULT_SLIDING_WINDOW_PERCENTAGE,
  };
}
