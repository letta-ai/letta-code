const NONE_REASONING_MODEL_PREFIXES = [
  "gpt-5.1",
  "gpt-5.2",
  "gpt-5.3",
  "gpt-5.4",
  "gpt-5.5",
  "gpt-5.6",
] as const;

function openaiModelNameFromHandle(
  modelHandleOrId: string | null | undefined,
): string | null {
  if (!modelHandleOrId) return null;
  const trimmed = modelHandleOrId.trim().toLowerCase();
  if (!trimmed) return null;
  const slashIndex = trimmed.lastIndexOf("/");
  const unprefixed =
    slashIndex === -1 ? trimmed : trimmed.slice(slashIndex + 1);
  return unprefixed.endsWith("-fast")
    ? unprefixed.slice(0, -"-fast".length)
    : unprefixed;
}

function supportsNoneReasoningEffort(model: string): boolean {
  return NONE_REASONING_MODEL_PREFIXES.some(
    (prefix) => model === prefix || model.startsWith(`${prefix}-`),
  );
}

/**
 * Repair legacy efforts that the selected model rejects on the wire.
 * GPT-5.5/5.6 (including ChatGPT Sol aliases) do not accept `minimal`.
 */
export function normalizeReasoningEffortForModel(
  modelHandleOrId: string | null | undefined,
  effort: string | null | undefined,
): string | null | undefined {
  if (effort == null) return effort;
  const model = openaiModelNameFromHandle(modelHandleOrId);
  if (!model) return effort;
  if (effort === "minimal" && supportsNoneReasoningEffort(model)) {
    return "none";
  }
  if (effort === "max" && model.startsWith("gpt-5.5")) {
    return "xhigh";
  }
  return effort;
}
