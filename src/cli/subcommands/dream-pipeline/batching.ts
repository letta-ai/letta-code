// Pack discovered sessions into sequential, size-bounded batches.
//
// Sessions are ordered by their first-record timestamp, then greedily packed:
// a batch closes when adding the next session would exceed the token budget or
// the session cap. Batches are therefore contiguous time segments, and a
// single oversized session still gets its own batch.

import type { DiscoveredSession } from "@/agent/trajectories/types";

export const DEFAULT_BATCH_TOKEN_BUDGET = 60_000;
export const DEFAULT_MAX_SESSIONS_PER_BATCH = 10;

export interface DreamBatch {
  index: number;
  sessions: DiscoveredSession[];
  estTokens: number;
  startTime: string;
  endTime: string;
}

export function packDreamBatches(
  sessions: DiscoveredSession[],
  tokenBudget: number,
  maxSessions: number,
): DreamBatch[] {
  const ordered = [...sessions].sort((a, b) =>
    a.startTime.localeCompare(b.startTime),
  );

  const batches: DreamBatch[] = [];
  let current: DiscoveredSession[] = [];
  let currentTokens = 0;

  const flush = () => {
    const first = current[0];
    const last = current[current.length - 1];
    if (!first || !last) return;
    batches.push({
      index: batches.length,
      sessions: current,
      estTokens: currentTokens,
      startTime: first.startTime,
      endTime: last.endTime,
    });
    current = [];
    currentTokens = 0;
  };

  for (const session of ordered) {
    const wouldOverflow =
      current.length > 0 &&
      (currentTokens + session.estTokens > tokenBudget ||
        current.length >= maxSessions);
    if (wouldOverflow) flush();
    current.push(session);
    currentTokens += session.estTokens;
  }
  flush();
  return batches;
}
