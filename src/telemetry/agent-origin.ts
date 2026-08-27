export type TelemetryAgentOrigin = "claude-subconscious";

const TELEMETRY_AGENT_ORIGIN_BY_TAG: ReadonlyMap<string, TelemetryAgentOrigin> =
  new Map([["origin:claude-subconcious", "claude-subconscious"]]);

export function resolveTelemetryAgentOrigin(
  tags: readonly string[] | null | undefined,
): TelemetryAgentOrigin | undefined {
  for (const tag of tags ?? []) {
    const origin = TELEMETRY_AGENT_ORIGIN_BY_TAG.get(tag);
    if (origin) {
      return origin;
    }
  }
  return undefined;
}
