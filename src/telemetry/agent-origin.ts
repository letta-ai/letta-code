const AGENT_ORIGIN_TAG_PREFIX = "origin:";
const MAX_AGENT_ORIGINS = 8;
const TELEMETRY_AGENT_ORIGIN_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function resolveTelemetryAgentOrigins(
  tags: readonly string[] | null | undefined,
): string[] {
  const origins = new Set<string>();

  for (const tag of tags ?? []) {
    if (!tag.startsWith(AGENT_ORIGIN_TAG_PREFIX)) {
      continue;
    }

    const origin = tag.slice(AGENT_ORIGIN_TAG_PREFIX.length);
    if (!TELEMETRY_AGENT_ORIGIN_PATTERN.test(origin)) {
      continue;
    }

    origins.add(origin);
    if (origins.size === MAX_AGENT_ORIGINS) {
      break;
    }
  }

  return [...origins];
}
