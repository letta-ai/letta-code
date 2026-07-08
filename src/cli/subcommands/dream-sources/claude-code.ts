import { createClaudeCodeSource } from "@/agent/trajectories/sources/claude-code";
import type { ExternalTranscriptEntry } from "@/cli/helpers/reflection-transcript";
import { normalizedSessionToExternalEntries } from "./trajectory";
import type { SourceAdapter } from "./types";

export const claudeCodeAdapter: SourceAdapter = {
  type: "claude",
  async convert(locator: string): Promise<ExternalTranscriptEntry[]> {
    const source = createClaudeCodeSource();
    const sessions = (await source.discover(locator)).sort((a, b) =>
      a.startTime.localeCompare(b.startTime),
    );
    if (sessions.length === 0) {
      throw new Error(`No Claude Code sessions found for ${locator}`);
    }

    const entries: ExternalTranscriptEntry[] = [];
    for (const session of sessions) {
      entries.push(
        ...normalizedSessionToExternalEntries(await source.normalize(session)),
      );
    }
    return entries;
  },
};
