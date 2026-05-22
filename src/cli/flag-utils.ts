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
}): number | undefined {
  const { rawValue, flagName } = options;
  if (rawValue === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(rawValue, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new Error(
      `--${flagName} must be a positive integer, got: ${rawValue}`,
    );
  }
  return parsed;
}

export function parseJsonArrayFlag(
  rawValue: string,
  flagName: string,
): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawValue);
  } catch (error) {
    throw new Error(
      `Invalid --${flagName} JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${flagName} must be a JSON array`);
  }
  return parsed;
}
