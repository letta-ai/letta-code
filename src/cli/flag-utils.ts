export const CLI_NUMERIC_OPTION_MAX = {
  pageSize: 1000,
  pageCount: 1000,
  timeoutSeconds: 86_400,
} as const;

export function parseCsvListFlag(
  value: string | undefined,
): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === "none") {
    return [];
  }

  return trimmed
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function normalizeConversationShorthandFlags(options: {
  specifiedConversationId: string | null | undefined;
  specifiedAgentId: string | null | undefined;
}) {
  let { specifiedConversationId, specifiedAgentId } = options;

  if (specifiedConversationId?.startsWith("agent-")) {
    if (specifiedAgentId && specifiedAgentId !== specifiedConversationId) {
      throw new Error(
        `Conflicting agent IDs: --agent ${specifiedAgentId} vs --conv ${specifiedConversationId}`,
      );
    }
    specifiedAgentId = specifiedConversationId;
    specifiedConversationId = "default";
  }

  return { specifiedConversationId, specifiedAgentId };
}

export function resolveImportFlagAlias(options: {
  importFlagValue: string | undefined;
  fromAfFlagValue: string | undefined;
}): string | undefined {
  return options.importFlagValue ?? options.fromAfFlagValue;
}

export function parsePositiveIntFlag(options: {
  rawValue: string | undefined;
  flagName: string;
  maxValue?: number;
}): number | undefined {
  const { rawValue, flagName, maxValue = Number.MAX_SAFE_INTEGER } = options;
  if (rawValue === undefined) {
    return undefined;
  }

  const trimmed = rawValue.trim();
  const parsed = Number(trimmed);
  if (
    !/^\d+$/.test(trimmed) ||
    !Number.isSafeInteger(parsed) ||
    parsed < 1 ||
    parsed > maxValue
  ) {
    const expected =
      maxValue === Number.MAX_SAFE_INTEGER
        ? "a positive integer"
        : `an integer between 1 and ${maxValue}`;
    throw new Error(`--${flagName} must be ${expected}, got: ${rawValue}`);
  }
  return parsed;
}
