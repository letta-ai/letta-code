// Filesystem helpers shared by the trajectory-source discovery paths.

import type { Stats } from "node:fs";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { NormalizeRowsResult } from "./normalize-core";
import type { DiscoveredSession } from "./types";
import { estimateTokens } from "./types";

export function statOrNull(path: string): Stats | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

/** Recursively list files under `dir` whose basename matches `match`. */
export function listFilesRecursive(
  dir: string,
  match: (name: string) => boolean,
): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries.sort()) {
    const path = join(dir, entry);
    const info = statOrNull(path);
    if (!info) continue;
    if (info.isDirectory()) {
      out.push(...listFilesRecursive(path, match));
    } else if (info.isFile() && match(entry)) {
      out.push(path);
    }
  }
  return out;
}

/**
 * Build a DiscoveredSession from a normalize result, or null when the session
 * was skipped or invalid. Time bounds come from the conversation records
 * (meta excluded); estTokens is ~chars/4 of the serialized transcript.
 */
export function buildDiscoveredSession(
  harness: string,
  sessionId: string,
  path: string,
  mtimeMs: number,
  result: NormalizeRowsResult,
): DiscoveredSession | null {
  if (result.status !== "ok" || !result.records) return null;
  const records = result.records;
  const meta = records[0]?.role === "meta" ? records[0] : undefined;
  const body = records.filter((r) => r.role !== "meta");
  const startTime = body[0]?.timestamp;
  const endTime = body[body.length - 1]?.timestamp;
  if (!startTime || !endTime) return null;
  return {
    harness,
    sessionId,
    path,
    startTime,
    endTime,
    estTokens: estimateTokens(JSON.stringify(records)),
    recordCount: body.length,
    mtimeMs,
    ...(meta?.cwd ? { cwd: meta.cwd } : {}),
  };
}

/**
 * Resolve a session-id locator against ids of store sessions: exact match
 * first, then unique-prefix semantics (all sessions whose id starts with the
 * locator).
 */
export function matchSessionIds<T extends { sessionId: string }>(
  locator: string,
  candidates: T[],
): T[] {
  const exact = candidates.filter((c) => c.sessionId === locator);
  if (exact.length > 0) return exact;
  return candidates.filter((c) => c.sessionId.startsWith(locator));
}
