/**
 * In-memory store for MCP originator tokens (USER_SCOPED_MCP_CONNECTIONS).
 *
 * The cloud relay delivers a short-lived originator token on the top-level
 * run-input frame (`mcp_originator_token`, alongside `super_run_id` — never
 * inside the user-message payload) when the super run is attributed to a
 * principal. The listener forwards that token as the
 * `x-letta-mcp-originator-token` header on MCP tool-run calls so cloud-api can
 * authorize user-scoped MCP connections on behalf of the originating
 * principal.
 *
 * Hygiene contract (pinned in the design doc):
 * - Tokens live ONLY in this process-local Map, keyed by super run id.
 * - The token value is never logged (boolean-presence diagnostics only),
 *   never persisted to disk, and never copied into tool args, transcripts,
 *   or durable listener records. Only the super run id may travel on turn
 *   plumbing (IncomingMessage, runtime context); lookups happen here.
 * - Entries are deleted when the owning run reaches a terminal state and the
 *   whole store is cleared on listener session teardown (and process exit).
 *
 * Ordering contract (mint generations):
 * - The producer re-mints per delivery attempt inside one atomic Lua script
 *   that INCRs a per-run generation counter, so every delivery carries a
 *   strictly newer generation than any earlier attempt. A delivery whose
 *   generation is OLDER than the stored entry is a zombie from a superseded
 *   attempt and is dropped; an equal generation is an idempotent re-delivery
 *   and last-write-wins within it.
 * - Mixed-version rule: an entry WITHOUT a generation was written by a
 *   legacy producer and accepts any delivery; an entry WITH a generation
 *   rejects legacy (generation-less) deliveries, including tokenless clears
 *   — a stale legacy frame must never erase known-newer authority.
 * - Tokenless deliveries record a tombstone (null token) rather than
 *   deleting, so a later stale create cannot resurrect the key below the
 *   tombstone's generation. Finalizers still hard-delete at terminal.
 *
 * Consumer side only: this module does not verify tokens, enforce ACLs, or
 * decide attribution. When no token is held for a run, callers simply omit
 * the header and the call proceeds unattributed.
 *
 * Authority floor (durable, mcp-originator-authority.ts): generation
 * comparison alone only protects against generations this volatile Map still
 * remembers. A durable per-run record carries the max observed generation
 * (the floor) plus a monotone live → headerless|terminal state across
 * restarts, so a zombie from a superseded mint is rejected even on an empty
 * Map, and a run whose authority was deliberately retired (origin swap,
 * mixed-batch merge, terminal) can never be re-armed by a duplicate frame.
 */

import {
  markMcpOriginatorHeaderless,
  markMcpOriginatorTerminal,
  mcpOriginatorAuthorityAllows,
  noteMcpOriginatorDelivery,
} from "./mcp-originator-authority";

type McpOriginatorTokenEntry = {
  /** Null marks a tombstone left by a tokenless delivery. */
  token: string | null;
  /** Producer mint generation; absent on legacy (pre-generation) entries. */
  generation?: number;
};

const entriesBySuperRunId = new Map<string, McpOriginatorTokenEntry>();

/**
 * Resolve the held token for a super run, or undefined when the run is
 * unattributed (no token delivered), the entry is a tombstone, or the token
 * was already dropped.
 */
export function getMcpOriginatorToken(
  superRunId: string | null | undefined,
): string | undefined {
  if (!superRunId) return undefined;
  return entriesBySuperRunId.get(superRunId)?.token ?? undefined;
}

/**
 * Seed a token directly (tests and local fixtures). Production entries only
 * ever arrive through recordMcpOriginatorDelivery; a seeded entry is legacy
 * (no generation) so any real delivery can supersede it.
 */
export function setMcpOriginatorToken(superRunId: string, token: string): void {
  entriesBySuperRunId.set(superRunId, { token });
}

/** Drop the token for a super run that reached a terminal state. */
export function deleteMcpOriginatorToken(superRunId: string): void {
  entriesBySuperRunId.delete(superRunId);
}

/** Drop every held token (listener session teardown, tests). */
export function clearMcpOriginatorTokens(): void {
  entriesBySuperRunId.clear();
}

/** Presence-only diagnostic: how many runs currently hold a token. */
export function mcpOriginatorTokenCount(): number {
  let count = 0;
  for (const entry of entriesBySuperRunId.values()) {
    if (entry.token !== null) count += 1;
  }
  return count;
}

/**
 * Extract the originator delivery from an inbound top-level run-input frame.
 *
 * This is the single parse site for the relay contract fields. Wire data is
 * untrusted: present-but-malformed values are treated as absent (the turn
 * then runs unattributed) rather than rejecting the whole input. A malformed
 * generation degrades to "legacy", which generated entries reject.
 */
export function readMcpOriginatorDelivery(payload: unknown): {
  superRunId?: string;
  token?: string;
  generation?: number;
} {
  const wire =
    typeof payload === "object" && payload !== null
      ? (payload as {
          super_run_id?: unknown;
          mcp_originator_token?: unknown;
          mcp_originator_generation?: unknown;
        })
      : {};
  const superRunId =
    typeof wire.super_run_id === "string" && wire.super_run_id.length > 0
      ? wire.super_run_id
      : undefined;
  const token =
    typeof wire.mcp_originator_token === "string" &&
    wire.mcp_originator_token.length > 0
      ? wire.mcp_originator_token
      : undefined;
  const generation =
    typeof wire.mcp_originator_generation === "number" &&
    Number.isInteger(wire.mcp_originator_generation) &&
    wire.mcp_originator_generation >= 0 &&
    Number.isSafeInteger(wire.mcp_originator_generation)
      ? wire.mcp_originator_generation
      : undefined;
  return {
    ...(superRunId ? { superRunId } : {}),
    ...(token ? { token } : {}),
    ...(generation !== undefined ? { generation } : {}),
  };
}

/**
 * Whether an incoming delivery is at least as new as the stored entry.
 * Legacy entries (no generation) accept anything; generated entries reject
 * legacy deliveries and older generations.
 */
function deliveryIsAtLeastAsNew(
  existing: McpOriginatorTokenEntry,
  incomingGeneration: number | undefined,
): boolean {
  if (existing.generation === undefined) return true;
  if (incomingGeneration === undefined) return false;
  return incomingGeneration >= existing.generation;
}

/**
 * Apply an accepted input's originator delivery to the store.
 *
 * Call only once the input has been ACCEPTED (queued or started); tokens
 * belonging to rejected or dropped inputs must never reach the store.
 *
 * `allowCreate: false` (duplicate re-acks and accepted approval/teleport
 * payloads — accepts that create no new owning turn) restricts the delivery
 * to refreshing an entry that already exists. Two escape hatches keep live
 * work from running headerless without reopening the orphaned-token hole:
 *
 * - `mayRecreateOwner`: when the entry is missing, the delivery may
 *   (re)create it if this predicate proves the DURABLE input ledger still
 *   shows a live accepted started/queued owner for this input — i.e. the
 *   work survived a process crash or an ACK loss and a finalizer still
 *   exists for it. Terminal disposition tombstones do not qualify, so a
 *   post-terminal duplicate can never re-insert an orphaned token.
 * - Tombstones count as existing entries for ordering purposes: a stale
 *   create below the tombstone generation is dropped even when recreation
 *   would otherwise be allowed.
 */
export function recordMcpOriginatorDelivery(
  frame: unknown,
  options?: { allowCreate?: boolean; mayRecreateOwner?: () => boolean },
): void {
  const delivery = readMcpOriginatorDelivery(frame);
  if (!delivery.superRunId) return;
  // Durable authority gate, consulted BEFORE the volatile entry check so an
  // empty Map inherits the floor: rejects zombies below the max observed
  // generation, legacy deliveries beneath a known generation contract, and
  // any delivery for a headerless/terminal run (origin swap, mixed merge,
  // terminal retirement are never re-armed by duplicates).
  if (!mcpOriginatorAuthorityAllows(delivery.superRunId, delivery.generation)) {
    return;
  }
  const existing = entriesBySuperRunId.get(delivery.superRunId);
  if (delivery.token) {
    if (existing) {
      if (!deliveryIsAtLeastAsNew(existing, delivery.generation)) return;
    } else if (
      options?.allowCreate === false &&
      options?.mayRecreateOwner?.() !== true
    ) {
      return;
    }
    entriesBySuperRunId.set(delivery.superRunId, {
      token: delivery.token,
      ...(delivery.generation !== undefined
        ? { generation: delivery.generation }
        : existing?.generation !== undefined
          ? { generation: existing.generation }
          : {}),
    });
    noteMcpOriginatorDelivery(delivery.superRunId, delivery.generation);
  } else {
    // Tokenless frame: clear stale authority, but never erase a generated
    // entry from beneath a known-newer contract (stale legacy/zombie clear),
    // and keep a tombstone so a later stale create cannot resurrect the key.
    // Even when no entry exists, a generation on the frame still bumps the
    // durable floor so a later zombie create cannot slip beneath it.
    noteMcpOriginatorDelivery(delivery.superRunId, delivery.generation);
    if (!existing) return;
    if (!deliveryIsAtLeastAsNew(existing, delivery.generation)) return;
    entriesBySuperRunId.set(delivery.superRunId, {
      token: null,
      ...(delivery.generation !== undefined
        ? { generation: delivery.generation }
        : existing.generation !== undefined
          ? { generation: existing.generation }
          : {}),
    });
  }
}

/**
 * Fail closed when a turn's originator authority changes mid-run.
 *
 * An approval continuation that consumes a queued input from a DIFFERENT
 * super run must not keep running under the original run's token, and the
 * queued run's own token is consumed by this very merge. Retire both runs'
 * held tokens so subsequent MCP calls omit the header (unattributed) instead
 * of borrowing either run's authority. Same-run follow-ups are a no-op and
 * keep their token (their run is still the one executing).
 */
export function retireMcpOriginatorTokensOnOriginSwap(
  turnSuperRunId: string | null | undefined,
  queuedSuperRunId: string | null | undefined,
): void {
  if (queuedSuperRunId === turnSuperRunId) return;
  // The swap is a deliberate fail-closed boundary: the continuation must stay
  // headerless for the rest of the turn, so both runs are marked headerless
  // durably — a duplicate frame (even with a live durable input owner) must
  // never recreate the deleted key and re-arm the header mid-turn.
  for (const runId of [turnSuperRunId, queuedSuperRunId]) {
    if (!runId) continue;
    const generation = entriesBySuperRunId.get(runId)?.generation;
    entriesBySuperRunId.delete(runId);
    markMcpOriginatorHeaderless(runId, generation);
  }
}

/**
 * Terminal retirement for the finalizer: drop the held token and mark the
 * run terminal durably, so a post-terminal duplicate can never re-insert an
 * orphaned token even after a restart forgot the deletion.
 */
export function retireMcpOriginatorTokenOnTerminal(
  superRunId: string | null | undefined,
): void {
  if (!superRunId) return;
  const generation = entriesBySuperRunId.get(superRunId)?.generation;
  entriesBySuperRunId.delete(superRunId);
  markMcpOriginatorTerminal(superRunId, generation);
}

/**
 * Mixed-batch merge retirement: constituents' tokens can never be
 * legitimately used by the unattributed merged turn, so they are retired and
 * durably marked headerless — the merged finalizer cannot delete them later,
 * and constituent duplicates must never recreate them.
 */
export function retireMcpOriginatorTokenOnMixedMerge(
  superRunId: string | null | undefined,
): void {
  if (!superRunId) return;
  const generation = entriesBySuperRunId.get(superRunId)?.generation;
  entriesBySuperRunId.delete(superRunId);
  markMcpOriginatorHeaderless(superRunId, generation);
}
