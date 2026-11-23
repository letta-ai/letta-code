import {
  type AnyTrajectorySource,
  listTrajectories,
  NormalizationError,
} from "@letta-ai/trajectory";

const FALLBACK_SOURCES = [
  "claude-code",
  "codex",
  "deepagents",
  "hermes",
  "letta-code",
  "openclaw",
  "openhands",
];

export async function listSupportedSources(): Promise<string[]> {
  try {
    await listTrajectories({ source: "__probe__" as AnyTrajectorySource });
  } catch (error) {
    if (error instanceof NormalizationError) {
      const match = /Supported sources: ([^.]+)\./.exec(error.message);
      const sources = match?.[1]
        ?.split(",")
        .map((name) => name.trim().replace(/^"|"$/g, ""))
        .filter(Boolean);
      if (sources && sources.length > 0) {
        return sources;
      }
    }
  }
  return [...FALLBACK_SOURCES];
}

export const CHECKPOINT_SOURCE = "deepagents";
