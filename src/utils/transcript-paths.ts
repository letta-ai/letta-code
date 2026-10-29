import { join } from "node:path";
import { resolveGlobalConfigDir } from "@/utils/settings-path";

/** Env override for the reflection transcript root. */
export const TRANSCRIPT_ROOT_ENV = "LETTA_TRANSCRIPT_ROOT";

/**
 * Root directory for reflection transcripts: `$LETTA_TRANSCRIPT_ROOT` when set,
 * else `<product-config>/transcripts`.
 *
 * Shared (rather than private to `reflection-transcript.ts`) so the filesystem
 * sandbox can carve it writable as a harness-metadata path: a memory-subagent
 * subagent persists its OWN transcript here via the headless loop, and the
 * write policy governs the agent's non-deterministic work, not harness artifacts.
 */
export function getTranscriptRoot(): string {
  const envRoot = process.env[TRANSCRIPT_ROOT_ENV]?.trim();
  if (envRoot) {
    return envRoot;
  }
  return join(resolveGlobalConfigDir(), "transcripts");
}
