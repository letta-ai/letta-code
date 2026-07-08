import { createCodexSource } from "@/agent/trajectories/sources/codex";
import type { ExternalTranscriptEntry } from "@/cli/helpers/reflection-transcript";
import { normalizedSessionToExternalEntries } from "./trajectory";
import type { SourceAdapter } from "./types";

export const codexAdapter: SourceAdapter = {
  type: "codex",
  async convert(locator: string): Promise<ExternalTranscriptEntry[]> {
    const source = createCodexSource();
    const sessions = (await source.discover(locator)).sort((a, b) =>
      a.startTime.localeCompare(b.startTime),
    );
    if (sessions.length === 0) {
      throw new Error(`No Codex sessions found for ${locator}`);
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
