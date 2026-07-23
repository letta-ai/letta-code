import {
  type AnyTrajectorySource,
  listTrajectories,
  NormalizationError,
} from "@letta-ai/trajectory";

/**
 * Snapshot of the sources trajectory supported when this file was written.
 * Used only when the runtime probe below fails; keeps the CLI working even if
 * the package's error format changes.
 */
const FALLBACK_SOURCES = [
  "claude-code",
  "codex",
  "deepagents",
  "hermes",
  "letta",
  "openclaw",
  "openhands",
];

/**
 * Enumerate every source supported by the *installed* `@letta-ai/trajectory`
 * package, so newly added harnesses are picked up on a dependency bump without
 * code changes here. The package exports the source list only as a TypeScript
 * union type, so at runtime we probe `listTrajectories` with an unknown source
 * and parse the authoritative list out of its error message.
 */
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

/** The one checkpoint-backed source; its sessions normalize via `normalizeCheckpoint`. */
export const CHECKPOINT_SOURCE = "deepagents";
