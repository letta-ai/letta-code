export const REFLECTION_STATE_SCHEMA_VERSION =
  "v4_canonical_assistant_steps" as const;

const LEGACY_STATE_SCHEMA_VERSIONS = new Set([
  "v2_message_id",
  "v3_assistant_steps",
]);

export interface ReflectionTranscriptState {
  schema_version: typeof REFLECTION_STATE_SCHEMA_VERSION;
  reflected_through_message_id?: string;
  total_completed_steps: number;
  reflected_completed_steps: number;
  steps_since_last_successful_reflection: number;
  last_reflection_started_at?: string;
  last_reflection_succeeded_at?: string;
}

export interface ReflectionStepEntry {
  kind: string;
  source_message_id?: string;
}

type StoredReflectionState = Record<string, unknown>;

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0
    ? value
    : 0;
}

export function normalizeCurrentReflectionTranscriptState(
  parsed: StoredReflectionState | null,
): ReflectionTranscriptState | null {
  if (parsed?.schema_version !== REFLECTION_STATE_SCHEMA_VERSION) {
    return null;
  }
  const totalCompletedSteps = nonNegativeInteger(parsed.total_completed_steps);
  const reflectedCompletedSteps = Math.min(
    nonNegativeInteger(parsed.reflected_completed_steps),
    totalCompletedSteps,
  );
  return {
    schema_version: REFLECTION_STATE_SCHEMA_VERSION,
    reflected_through_message_id: nonEmptyString(
      parsed.reflected_through_message_id,
    ),
    total_completed_steps: totalCompletedSteps,
    reflected_completed_steps: reflectedCompletedSteps,
    steps_since_last_successful_reflection: Math.max(
      0,
      totalCompletedSteps - reflectedCompletedSteps,
    ),
    last_reflection_started_at: nonEmptyString(
      parsed.last_reflection_started_at,
    ),
    last_reflection_succeeded_at: nonEmptyString(
      parsed.last_reflection_succeeded_at,
    ),
  };
}

export function countCanonicalAssistantSteps(
  entries: ReflectionStepEntry[],
): number {
  const canonicalIds = new Set<string>();
  let fallbackRows = 0;
  for (const entry of entries) {
    if (entry.kind !== "assistant") continue;
    const messageId = nonEmptyString(entry.source_message_id);
    if (messageId) canonicalIds.add(messageId);
    else fallbackRows += 1;
  }
  return canonicalIds.size + fallbackRows;
}

function isCanonicalAnchorEntry(entry: ReflectionStepEntry): boolean {
  return (
    (entry.kind === "user" || entry.kind === "assistant") &&
    nonEmptyString(entry.source_message_id) !== undefined
  );
}

function lastAnchorIndex(
  entries: ReflectionStepEntry[],
  reflectedThroughMessageId?: string,
): number {
  if (!reflectedThroughMessageId) return -1;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (
      entry &&
      isCanonicalAnchorEntry(entry) &&
      entry.source_message_id === reflectedThroughMessageId
    ) {
      return index;
    }
  }
  return -1;
}

/**
 * Rebuild counters from the transcript during state migration. Older schemas
 * counted display rows, so their numeric counters are not reliable. The
 * canonical message anchor is reliable when it still exists; otherwise replay
 * all transcript steps rather than marking unseen content complete.
 */
export function rebuildReflectionTranscriptState(
  parsed: StoredReflectionState | null,
  entries: ReflectionStepEntry[],
): ReflectionTranscriptState {
  const schemaVersion = parsed?.schema_version;
  const canMigrateMetadata =
    typeof schemaVersion === "string" &&
    LEGACY_STATE_SCHEMA_VERSIONS.has(schemaVersion);
  const reflectedThroughMessageId = canMigrateMetadata
    ? nonEmptyString(parsed?.reflected_through_message_id)
    : undefined;
  const anchorIndex = lastAnchorIndex(entries, reflectedThroughMessageId);
  const totalCompletedSteps = countCanonicalAssistantSteps(entries);
  const reflectedCompletedSteps =
    anchorIndex < 0
      ? 0
      : countCanonicalAssistantSteps(entries.slice(0, anchorIndex + 1));

  return {
    schema_version: REFLECTION_STATE_SCHEMA_VERSION,
    reflected_through_message_id:
      anchorIndex < 0 ? undefined : reflectedThroughMessageId,
    total_completed_steps: totalCompletedSteps,
    reflected_completed_steps: reflectedCompletedSteps,
    steps_since_last_successful_reflection: Math.max(
      0,
      totalCompletedSteps - reflectedCompletedSteps,
    ),
    last_reflection_started_at: canMigrateMetadata
      ? nonEmptyString(parsed?.last_reflection_started_at)
      : undefined,
    last_reflection_succeeded_at: canMigrateMetadata
      ? nonEmptyString(parsed?.last_reflection_succeeded_at)
      : undefined,
  };
}
