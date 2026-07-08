// Per-agent ingest ledger: which harness sessions have already been reflected
// on, so repeated `letta dream --from claude` runs only process new (or
// changed) sessions. A session is skipped when the ledger holds an entry whose
// recorded mtime is not older than the session file's current mtime; a session
// that grew after being reflected (mtime advanced) is re-ingested whole.
//
// The ledger is only updated after a run's aggregation commits successfully,
// so a failed run leaves every session eligible for the next attempt.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { DiscoveredSession } from "@/agent/trajectories/types";
import { safeJsonParseOr } from "@/cli/helpers/safe-json-parse";
import { withFileLock } from "@/utils/file-lock";
import { getDreamLedgerPath } from "./paths";

const DREAM_LEDGER_SCHEMA_VERSION = "v1" as const;

export interface DreamLedgerEntry {
  mtimeMs: number;
  reflectedAt: string;
  runId: string;
}

export interface DreamLedger {
  schema_version: typeof DREAM_LEDGER_SCHEMA_VERSION;
  sessions: Record<string, DreamLedgerEntry>;
}

export function dreamLedgerKey(session: DiscoveredSession): string {
  return `${session.harness}:${session.sessionId}`;
}

function emptyLedger(): DreamLedger {
  return { schema_version: DREAM_LEDGER_SCHEMA_VERSION, sessions: {} };
}

export async function readDreamLedger(agentId: string): Promise<DreamLedger> {
  let raw: string;
  try {
    raw = await readFile(getDreamLedgerPath(agentId), "utf-8");
  } catch {
    return emptyLedger();
  }
  const parsed = safeJsonParseOr<Partial<DreamLedger> | null>(raw, null);
  if (
    !parsed ||
    parsed.schema_version !== DREAM_LEDGER_SCHEMA_VERSION ||
    typeof parsed.sessions !== "object" ||
    parsed.sessions === null
  ) {
    return emptyLedger();
  }
  return {
    schema_version: DREAM_LEDGER_SCHEMA_VERSION,
    sessions: parsed.sessions,
  };
}

export interface LedgerFilterResult {
  fresh: DiscoveredSession[];
  skipped: DiscoveredSession[];
}

/** Split sessions into ones needing reflection vs already-covered ones. */
export function filterSessionsAgainstLedger(
  ledger: DreamLedger,
  sessions: DiscoveredSession[],
): LedgerFilterResult {
  const fresh: DiscoveredSession[] = [];
  const skipped: DiscoveredSession[] = [];
  for (const session of sessions) {
    const entry = ledger.sessions[dreamLedgerKey(session)];
    if (entry && entry.mtimeMs >= session.mtimeMs) {
      skipped.push(session);
    } else {
      fresh.push(session);
    }
  }
  return { fresh, skipped };
}

/** Record sessions as reflected. Called only after a successful aggregation. */
export async function recordDreamedSessions(
  agentId: string,
  sessions: DiscoveredSession[],
  runId: string,
): Promise<void> {
  const ledgerPath = getDreamLedgerPath(agentId);
  await mkdir(dirname(ledgerPath), { recursive: true });
  await withFileLock(`${ledgerPath}.lock`, async () => {
    const ledger = await readDreamLedger(agentId);
    const reflectedAt = new Date().toISOString();
    for (const session of sessions) {
      ledger.sessions[dreamLedgerKey(session)] = {
        mtimeMs: session.mtimeMs,
        reflectedAt,
        runId,
      };
    }
    await writeFile(
      ledgerPath,
      `${JSON.stringify(ledger, null, 2)}\n`,
      "utf-8",
    );
  });
}
