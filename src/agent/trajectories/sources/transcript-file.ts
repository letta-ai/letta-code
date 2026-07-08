// Passthrough source for transcripts already in the normalized-v1 format:
// `.json` files whose content is a record array (optional leading meta).
// Reading/validation ported from `loadSessionTrace`/`listJsonFiles` in the
// batch-reflection prototype's batching.ts.

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import {
  listFilesRecursive,
  statOrNull,
} from "@/agent/trajectories/store-utils";
import type {
  DiscoveredSession,
  NormalizedRecord,
  NormalizedSession,
  TrajectorySource,
} from "@/agent/trajectories/types";
import {
  estimateTokens,
  isNormalizedRecordArray,
} from "@/agent/trajectories/types";

interface LoadedTranscript {
  session: DiscoveredSession;
  records: NormalizedRecord[];
}

/** Load a single normalized transcript file, or null if the file is not a
 * normalized-v1 transcript. */
function loadTranscriptFile(path: string): LoadedTranscript | null {
  const info = statOrNull(path);
  if (!info?.isFile()) return null;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isNormalizedRecordArray(parsed) || parsed.length === 0) return null;
  const records = parsed;
  const meta = records[0]?.role === "meta" ? records[0] : undefined;
  const body = records.filter((r) => r.role !== "meta");
  if (body.length === 0) return null;
  const timestamps = body
    .map((r) => r.timestamp)
    .filter((t): t is string => typeof t === "string");
  const startTime = timestamps[0];
  const endTime = timestamps[timestamps.length - 1];
  if (!startTime || !endTime) return null;
  return {
    session: {
      harness: "transcript",
      sessionId: basename(path).replace(/\.json$/, ""),
      path,
      startTime,
      endTime,
      estTokens: estimateTokens(raw),
      recordCount: body.length,
      mtimeMs: info.mtimeMs,
      ...(meta?.cwd ? { cwd: meta.cwd } : {}),
    },
    records,
  };
}

/**
 * Trajectory source for normalized-v1 transcript files: a single `.json`
 * file, or a directory tree of them. There is no default store, so `discover`
 * requires a locator.
 */
export function createTranscriptFileSource(): TrajectorySource {
  return {
    type: "transcript",

    async discover(locator?: string): Promise<DiscoveredSession[]> {
      if (!locator) {
        throw new Error(
          "The transcript source has no default local store; pass a locator " +
            "(a normalized-v1 .json file or a directory of them), " +
            "e.g. --from transcript:<path>",
        );
      }
      const info = statOrNull(locator);
      if (!info) {
        throw new Error(`No such transcript path: ${locator}`);
      }
      const files = info.isDirectory()
        ? listFilesRecursive(locator, (name) => name.endsWith(".json"))
        : [locator];
      const sessions: DiscoveredSession[] = [];
      for (const file of files) {
        const loaded = loadTranscriptFile(file);
        if (loaded) sessions.push(loaded.session);
      }
      sessions.sort((a, b) => a.startTime.localeCompare(b.startTime));
      return sessions;
    },

    async normalize(session: DiscoveredSession): Promise<NormalizedSession> {
      const loaded = loadTranscriptFile(session.path);
      if (!loaded) {
        throw new Error(`Not a normalized-v1 transcript: ${session.path}`);
      }
      return { session, records: loaded.records };
    },
  };
}
