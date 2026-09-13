import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { TrajectoryListing } from "@letta-ai/trajectory";

/**
 * Turn a `listTrajectories()` item into the transcript string that
 * `normalizeTranscript()` expects. Discovery itself lives in the trajectory
 * package; this is the one remaining per-store-shape step, keyed by what the
 * item's `path` points at rather than by source name so future sources with a
 * familiar shape work without changes here:
 *
 * - a transcript file (claude-code, codex, letta-code, openclaw): read it
 * - a session event directory (openhands): assemble the JSON event array
 * - a SQLite store (hermes): export the session's rows as the documented
 *   `{session, messages}` envelope
 *
 * The checkpoint-backed `deepagents` source never comes through here — its
 * sessions normalize via `normalizeCheckpoint` directly.
 */
export async function loadSessionTranscript(
  item: TrajectoryListing,
): Promise<string> {
  const stats = await stat(item.path);
  if (stats.isDirectory()) {
    return assembleEventDirectory(item.path);
  }
  if (item.path.endsWith(".db")) {
    return exportHermesSession(item.path, item.id);
  }
  return readFile(item.path, "utf-8");
}

/**
 * OpenHands-style store: one JSON file per event, ordered by numeric filename,
 * either directly in the session directory or in an `events/` subdirectory.
 */
async function assembleEventDirectory(sessionDir: string): Promise<string> {
  const eventsSubdir = join(sessionDir, "events");
  const eventsDir = (await stat(eventsSubdir).catch(() => null))?.isDirectory()
    ? eventsSubdir
    : sessionDir;
  const names = (await readdir(eventsDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort(
      (a, b) =>
        Number.parseInt(a, 10) - Number.parseInt(b, 10) || a.localeCompare(b),
    );
  if (names.length === 0) {
    throw new Error(`No event files found in ${eventsDir}`);
  }
  const events = await Promise.all(
    names.map(async (name) =>
      JSON.parse(await readFile(join(eventsDir, name), "utf-8")),
    ),
  );
  return JSON.stringify(events);
}

interface ReadOnlyDatabase {
  all(sql: string, ...params: unknown[]): Record<string, unknown>[];
  close(): void;
}

/**
 * Open a SQLite database read-only on whichever runtime is available:
 * `node:sqlite` (Node 22.5+) or `bun:sqlite`. The specifier is passed through
 * a variable so bundlers keep the import dynamic instead of resolving it at
 * build time.
 */
async function openReadOnlyDatabase(path: string): Promise<ReadOnlyDatabase> {
  const dynamicImport = (specifier: string) => import(specifier);
  try {
    const sqlite = await dynamicImport("node:sqlite");
    const database = new sqlite.DatabaseSync(path, { readOnly: true });
    return {
      all: (sql, ...params) => database.prepare(sql).all(...params),
      close: () => database.close(),
    };
  } catch (error) {
    if (
      error instanceof Error &&
      !/Cannot find|Could not resolve|not supported/i.test(error.message)
    ) {
      throw error;
    }
  }
  const sqlite = await dynamicImport("bun:sqlite");
  const database = new sqlite.Database(path, { readonly: true });
  return {
    all: (sql, ...params) => database.query(sql).all(...params),
    close: () => database.close(),
  };
}

/**
 * Export one Hermes session from its SQLite store as the envelope the hermes
 * adapter documents: `{"session": <sessions row>, "messages": [<message rows
 * for the session, ordered by id>]}`.
 */
async function exportHermesSession(
  storePath: string,
  sessionId: string,
): Promise<string> {
  const database = await openReadOnlyDatabase(storePath);
  try {
    const sessions = database.all(
      "SELECT * FROM sessions WHERE id = ?",
      sessionId,
    );
    const messages = database.all(
      "SELECT * FROM messages WHERE session_id = ? ORDER BY id",
      sessionId,
    );
    return JSON.stringify({
      session: sessions[0] ?? { id: sessionId },
      messages,
    });
  } finally {
    database.close();
  }
}
