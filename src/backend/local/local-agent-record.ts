import { randomUUID } from "node:crypto";
import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import { LETTA_CODE_SUBAGENT_TAG } from "@/agent/agent-tags";
import type { AgentCreateBody } from "@/backend/backend";
import { isRecord } from "@/utils/type-guards";
import {
  localLlmConfigModelPatch,
  modelHandleFromLegacyLlmConfig,
  normalizeLocalModelHandle,
  supportedModelSettingsFromBody,
} from "./local-model-normalization";
import type { LocalAgentRecord } from "./local-types";

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function normalizeAgentHiddenFlag(
  hidden: unknown,
  tags: string[],
): boolean | null | undefined {
  if (typeof hidden === "boolean") return hidden;
  if ((hidden === undefined || hidden === null) && isSubagentTags(tags)) {
    return true;
  }
  return hidden === null ? null : undefined;
}

function isSubagentTags(tags: string[]): boolean {
  return tags.includes(LETTA_CODE_SUBAGENT_TAG);
}

export function isHiddenLocalAgentRecord(record: {
  hidden?: boolean | null;
  tags?: unknown;
}): boolean {
  const tags = isStringArray(record.tags) ? record.tags : [];
  return (
    record.hidden === true || (record.hidden == null && isSubagentTags(tags))
  );
}

export function shouldPersistSubagentHiddenBackfill(
  raw: unknown,
  record: LocalAgentRecord,
): boolean {
  return (
    isRecord(raw) &&
    (raw.hidden === undefined || raw.hidden === null) &&
    record.hidden === true &&
    isSubagentTags(record.tags)
  );
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalStringOrNull(value: unknown): string | null | undefined {
  return typeof value === "string" || value === null ? value : undefined;
}

export function createDefaultAgentRecord(
  agentId: string,
  defaultAgentName: string,
  defaultAgentModel: string,
): LocalAgentRecord {
  return {
    id: agentId,
    name: defaultAgentName,
    description: null,
    system: "",
    tags: [],
    model: defaultAgentModel,
    model_settings: {},
  };
}

export function createLocalAgentRecord(
  body: AgentCreateBody,
  defaultAgentName: string,
  defaultAgentModel: string,
): LocalAgentRecord {
  const bodyRecord = body as Record<string, unknown>;
  const tags = isStringArray(bodyRecord.tags) ? bodyRecord.tags : [];
  const hidden = normalizeAgentHiddenFlag(bodyRecord.hidden, tags);
  const modelSettings = supportedModelSettingsFromBody(bodyRecord);
  const requestedModel = optionalString(bodyRecord.model) ?? defaultAgentModel;
  return {
    id: `agent-local-${randomUUID()}`,
    name: optionalString(bodyRecord.name) ?? defaultAgentName,
    description: optionalStringOrNull(bodyRecord.description) ?? null,
    system: optionalString(bodyRecord.system) ?? "",
    tags,
    model: normalizeLocalModelHandle(requestedModel, modelSettings),
    model_settings: modelSettings,
    ...(hidden !== undefined ? { hidden } : {}),
  };
}

export function shouldUseDefaultLocalModel(model: unknown): boolean {
  return (
    typeof model !== "string" ||
    model.length === 0 ||
    model === "auto" ||
    model.startsWith("letta/")
  );
}

function optionalRecordOrNull(
  value: unknown,
): Record<string, unknown> | null | undefined {
  if (value === null) return null;
  return isRecord(value) ? { ...value } : undefined;
}

export function normalizeAgentRecord(
  value: unknown,
  defaultAgentModel: string,
): LocalAgentRecord | undefined {
  if (!isRecord(value) || typeof value.id !== "string") return undefined;
  const modelSettings = isRecord(value.model_settings)
    ? { ...value.model_settings }
    : {};
  const legacyLlmConfig = isRecord(value.llm_config) ? value.llm_config : {};
  if (
    modelSettings.context_window_limit === undefined &&
    typeof legacyLlmConfig.context_window === "number"
  ) {
    modelSettings.context_window_limit = legacyLlmConfig.context_window;
  }
  if (
    modelSettings.max_tokens === undefined &&
    (typeof legacyLlmConfig.max_tokens === "number" ||
      legacyLlmConfig.max_tokens === null)
  ) {
    modelSettings.max_tokens = legacyLlmConfig.max_tokens;
  }

  const compactionSettings = optionalRecordOrNull(value.compaction_settings);
  const tags = isStringArray(value.tags) ? value.tags : [];
  const hidden = normalizeAgentHiddenFlag(value.hidden, tags);
  const storedModel = optionalString(value.model);
  const legacyModel = modelHandleFromLegacyLlmConfig(legacyLlmConfig);
  const model = storedModel
    ? normalizeLocalModelHandle(storedModel, modelSettings, legacyLlmConfig)
    : (legacyModel ?? defaultAgentModel);
  return {
    id: value.id,
    name: optionalString(value.name) ?? "Letta Code",
    description: optionalStringOrNull(value.description) ?? null,
    system: optionalString(value.system) ?? "",
    tags,
    model,
    model_settings: modelSettings,
    ...(hidden !== undefined ? { hidden } : {}),
    ...(compactionSettings !== undefined
      ? { compaction_settings: compactionSettings }
      : {}),
  };
}

export function projectLocalAgentState(
  record: LocalAgentRecord,
  messageIds: string[] = [],
  inContextMessageIds: string[] = messageIds,
  lastRunCompletion?: string | null,
): AgentState {
  const hidden = normalizeAgentHiddenFlag(record.hidden, record.tags);
  const nestedReasoning = isRecord(record.model_settings.reasoning)
    ? record.model_settings.reasoning
    : undefined;
  const reasoningEffort =
    typeof nestedReasoning?.reasoning_effort === "string"
      ? nestedReasoning.reasoning_effort
      : typeof record.model_settings.effort === "string"
        ? record.model_settings.effort
        : typeof record.model_settings.reasoning_effort === "string"
          ? record.model_settings.reasoning_effort
          : undefined;
  const enableReasoner =
    isRecord(record.model_settings.thinking) &&
    record.model_settings.thinking.type === "disabled"
      ? false
      : typeof record.model_settings.enable_reasoner === "boolean"
        ? record.model_settings.enable_reasoner
        : undefined;
  const llmConfigModelPatch = localLlmConfigModelPatch(
    record.model,
    record.model_settings,
  );
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    system: record.system,
    tools: [],
    tags: record.tags,
    model: record.model,
    model_settings: record.model_settings,
    ...(hidden !== undefined ? { hidden } : {}),
    ...(record.compaction_settings !== undefined
      ? { compaction_settings: record.compaction_settings }
      : {}),
    message_ids: messageIds,
    in_context_message_ids: inContextMessageIds,
    ...(lastRunCompletion ? { last_run_completion: lastRunCompletion } : {}),
    // Temporary compatibility shim for older runtime call sites. Local storage
    // keeps only `model` + `model_settings`.
    llm_config: {
      ...llmConfigModelPatch,
      model_endpoint: "https://example.invalid/v1",
      context_window:
        typeof record.model_settings.context_window_limit === "number"
          ? record.model_settings.context_window_limit
          : 128000,
      ...(reasoningEffort && { reasoning_effort: reasoningEffort }),
      ...(enableReasoner !== undefined && { enable_reasoner: enableReasoner }),
      ...((typeof record.model_settings.max_tokens === "number" ||
        record.model_settings.max_tokens === null) && {
        max_tokens: record.model_settings.max_tokens,
      }),
    },
  } as unknown as AgentState;
}
