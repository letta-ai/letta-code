// Session selection for a dream run: parse `--from` specs, discover sessions
// per trajectory source, apply cursor semantics, and dedupe across sources.
// Every run re-processes whatever its specs select; use cursors to narrow.
//
// Spec forms:
//   "claude"                 → all sessions in the harness's default store
//   "claude:<session>"       → CURSOR: that session and every later-starting
//                              session, store-wide (harnesses with a default
//                              store only)
//   "openhands:<path>"       → exactly the session(s) the locator names
//   "transcript:<path>"      → normalized-v1 file or directory tree
//   "letta[:<locator>]"      → a letta conversation's recorded transcript;
//                              locator is <conversation-id>, <agent-id>
//                              (default conversation), or <agent>/<conv> —
//                              defaults to the dream agent's default history
//   "<conversation-id>"      → NOT a pipeline source; parseDreamSourceSpec
//                              returns null and the caller uses the legacy
//                              single-conversation reflection path.

import {
  getTrajectorySource,
  listTrajectorySourceTypes,
} from "@/agent/trajectories/registry";
import type { DiscoveredSession } from "@/agent/trajectories/types";

/**
 * Harnesses whose sources can discover a whole local store with no locator.
 * For these, a locator resolving to a single session acts as a time cursor
 * ("this session onwards, store-wide") rather than selecting only itself.
 */
const CURSOR_CAPABLE_TYPES = new Set(["claude", "codex"]);

/**
 * Canonicalize a `letta:` locator to `<agent-id>/<conversation-id>`:
 *   letta                       → <dream agent>'s default conversation
 *   letta:<conversation-id>     → that conversation of the dream agent
 *   letta:<agent-id>            → that agent's default conversation
 *   letta:<agent>/<conversation> → as written
 */
function canonicalizeLettaLocator(
  dreamAgentId: string,
  locator: string | undefined,
): string {
  if (!locator) return `${dreamAgentId}/default`;
  if (locator.includes("/")) return locator;
  if (locator.startsWith("agent-")) return `${locator}/default`;
  return `${dreamAgentId}/${locator}`;
}

export interface DreamSourceSpec {
  type: string;
  locator?: string;
}

/**
 * Parse a `--from` value into a pipeline source spec, or null when the value
 * is a bare conversation id (the agent's own history — legacy path). A bare
 * value matching a registered source type ("claude", "codex", ...) is treated
 * as that source with no locator. Throws on `<type>:<locator>` with an
 * unregistered type.
 */
export function parseDreamSourceSpec(spec: string): DreamSourceSpec | null {
  const knownTypes = listTrajectorySourceTypes();
  const sep = spec.indexOf(":");
  if (sep < 0) {
    return knownTypes.includes(spec) ? { type: spec } : null;
  }
  const type = spec.slice(0, sep);
  const locator = spec.slice(sep + 1);
  if (!knownTypes.includes(type)) {
    throw new Error(
      `Unknown source type "${type}". Supported: ${knownTypes.join(", ")}`,
    );
  }
  return locator ? { type, locator } : { type };
}

/** A stable identity for a discovered session across sources. */
export function sessionKey(session: DiscoveredSession): string {
  return `${session.harness}:${session.sessionId}`;
}

async function discoverForSpec(
  dreamAgentId: string,
  spec: DreamSourceSpec,
): Promise<DiscoveredSession[]> {
  const source = getTrajectorySource(spec.type);
  const locator =
    spec.type === "letta"
      ? canonicalizeLettaLocator(dreamAgentId, spec.locator)
      : spec.locator;
  if (!locator) {
    return source.discover();
  }
  const located = await source.discover(locator);
  const cursor = located.length === 1 ? located[0] : undefined;
  if (cursor && CURSOR_CAPABLE_TYPES.has(spec.type)) {
    const all = await source.discover();
    const onward = all.filter(
      (session) => session.startTime.localeCompare(cursor.startTime) >= 0,
    );
    // The named session itself must be included even if the store scan
    // somehow misses it (e.g. it was moved); dedupe below handles overlap.
    return [cursor, ...onward];
  }
  return located;
}

/** Discover, dedupe, and time-order the sessions the specs select. */
export async function selectDreamSessions(params: {
  agentId: string;
  specs: DreamSourceSpec[];
}): Promise<DiscoveredSession[]> {
  const byKey = new Map<string, DiscoveredSession>();
  for (const spec of params.specs) {
    for (const session of await discoverForSpec(params.agentId, spec)) {
      const key = sessionKey(session);
      if (!byKey.has(key)) {
        byKey.set(key, session);
      }
    }
  }
  return [...byKey.values()].sort((a, b) =>
    a.startTime.localeCompare(b.startTime),
  );
}
