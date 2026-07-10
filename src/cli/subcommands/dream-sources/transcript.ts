import { readFile } from "node:fs/promises";
import type { ExternalTranscriptEntry } from "@/cli/helpers/reflection-transcript";
import { safeJsonParseOr } from "@/cli/helpers/safe-json-parse";
import type { SourceAdapter } from "./types";

/**
 * Reference adapter: a passthrough of transcript-entry JSONL (one
 * ExternalTranscriptEntry object per line). This is the simplest adapter and
 * the template to copy when adding a new source type — a new adapter only has
 * to map its own format into `ExternalTranscriptEntry[]`.
 */
export const transcriptAdapter: SourceAdapter = {
  type: "transcript",
  async convert(locator: string): Promise<ExternalTranscriptEntry[]> {
    const raw = await readFile(locator, "utf-8");
    const entries: ExternalTranscriptEntry[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const entry = safeJsonParseOr<ExternalTranscriptEntry | null>(
        trimmed,
        null,
      );
      if (!entry || typeof entry !== "object" || !("kind" in entry)) {
        throw new Error(`Could not parse a JSONL transcript row in ${locator}`);
      }
      entries.push(entry);
    }
    return entries;
  },
};
