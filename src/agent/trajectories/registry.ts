// Registry of the built-in trajectory sources, keyed by the scheme used in
// `--from <type>[:<locator>]`.

import { createClaudeCodeSource } from "./sources/claude-code";
import { createCodexSource } from "./sources/codex";
import { createLettaSource } from "./sources/letta";
import { createNormalizedFileSource } from "./sources/normalized-file";
import { createOpenHandsSource } from "./sources/openhands";
import type { TrajectorySource } from "./types";

const FACTORIES: Record<string, () => TrajectorySource> = {
  claude: () => createClaudeCodeSource(),
  codex: () => createCodexSource(),
  letta: () => createLettaSource(),
  openhands: () => createOpenHandsSource(),
  transcript: () => createNormalizedFileSource(),
};

export function getTrajectorySource(type: string): TrajectorySource {
  const factory = FACTORIES[type];
  if (!factory) {
    throw new Error(
      `Unknown trajectory source type "${type}". Supported types: ${Object.keys(
        FACTORIES,
      ).join(", ")}`,
    );
  }
  return factory();
}

export function listTrajectorySourceTypes(): string[] {
  return Object.keys(FACTORIES);
}
