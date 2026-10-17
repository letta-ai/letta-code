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
  admitMcpOriginatorDelivery,
  markMcpOriginatorHeaderless,
  markMcpOriginatorTerminal,
  mcpOriginatorAuthorityPermitsUse,
} from "./mcp-originator-authority";
import {
  startMcpOriginatorKeepalive,
  stopAllMcpOriginatorKeepalives,
  stopMcpOriginatorKeepalive,
} from "./mcp-originator-keepalive";

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
  const entry = entriesBySuperRunId.get(superRunId);
  if (!entry || entry.token === null) return undefined;
  // Use-time durable recheck (evil-shub round-5 P1): admission alone is not
  // authority for the token's whole lifetime. A revoked or deliberately
  // retired run (headerless/terminal, or a floor advanced past the held
  // generation by a newer delivery) must not keep spending the held token
  // — withdraw it here so the scoped call proceeds unattributed. The check
  // is a locked durable read and fails closed (degraded file → no header).
  if (!mcpOriginatorAuthorityPermitsUse(superRunId, entry.generation)) {
    deleteMcpOriginatorToken(superRunId);
    return undefined;
  }
  return entry.token;
}

/**
 * Seed a token directly (tests and local fixtures). Production entries only
 * ever arrive through recordMcpOriginatorDelivery; a seeded entry is legacy
 * (no generation) so any real delivery can supersede it.
 */
export function setMcpOriginatorToken(superRunId: string, token: string): void {
  entriesBySuperRunId.set(superRunId, { token });
  startMcpOriginatorKeepalive(superRunId, keepaliveHooks(superRunId));
}

/** Drop the token for a super run that reached a terminal state. */
export function deleteMcpOriginatorToken(superRunId: string): void {
  entriesBySuperRunId.delete(superRunId);
  stopMcpOriginatorKeepalive(superRunId);
}

/**
 * Hook bundle handed to the keepalive so the renewal loop can read and
 * withdraw this run's entry without importing the store — the dependency
 * stays one-way (store → keepalive) and the import graph acyclic.
 */
function keepaliveHooks(superRunId: string): {
  getToken: () => string | undefined;
  withdraw: () => void;
} {
  return {
    getToken: () => getMcpOriginatorToken(superRunId),
    withdraw: () => deleteMcpOriginatorToken(superRunId),
  };
}

/** Drop every held token (listener session teardown, tests). */
export function clearMcpOriginatorTokens(): void {
  entriesBySuperRunId.clear();
  stopAllMcpOriginatorKeepalives();
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
 * The parsed originator delivery from an inbound frame — the single shape
 * the pre-commit gate hands to the ack path so the ack installs EXACTLY
 * what was admitted (evil-shub round-9 P1).
 */
export type McpOriginatorParsedDelivery = {
  superRunId?: string;
  token?: string;
  generation?: number;
  /**
   * True when the frame CARRIED a generation that failed shape validation —
   * distinguishable from a legacy frame carrying no generation at all.
   */
  malformedGeneration?: boolean;
};

/**
 * Extract the originator delivery from an inbound top-level run-input frame.
 *
 * This is the single parse site for the relay contract fields. Wire data is
 * untrusted: present-but-malformed tokens/ids are treated as absent (the
 * turn then runs unattributed) rather than rejecting the whole input. A
 * present-but-malformed GENERATION is different (evil-shub round-6 P1 #1):
 * degrading it to "legacy" would let a first malformed delivery install a
 * token beneath the generation contract entirely (no floor exists yet to
 * reject it), so the parse surfaces `malformedGeneration` and admission
 * denies the delivery fail-closed.
 */
export function readMcpOriginatorDelivery(
  payload: unknown,
): McpOriginatorParsedDelivery {
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
    ...(wire.mcp_originator_generation !== undefined && generation === undefined
      ? { malformedGeneration: true as const }
      : {}),
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
 * Used only by ack paths that did NOT pass through the router's pre-commit
 * gate (duplicate re-acks and accepted approval payloads): it evaluates
 * admission itself. Gated frames use installPreGatedMcpOriginatorDelivery
 * instead — the gate's verdict is their single admission decision.
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
/**
 * Outcome of recording a delivery (evil-shub round-6 P1, split in round 8).
 *
 * - "denied_retryable": the durable admission gate could not be evaluated
 *   (degraded authority file, failed transaction). The caller MUST NOT ack
 *   the frame and MUST NOT commit work for it: Cloud's delivery gate
 *   treats an unacked frame as undeliverable and redelivers, retrying the
 *   whole admission once the infrastructure heals.
 * - "denied_permanent": this exact delivery can never be admitted — a
 *   stale generation at-or-below the durable floor, a legacy delivery
 *   beneath a known generation contract, a headerless/terminal run, or a
 *   malformed generation. Redelivering it would loop forever with zero
 *   chance of success, so the caller CONSUMES the frame (acks or rejects
 *   it, per path) without installing a token and without running work
 *   under it.
 * - "admitted" covers every post-admission outcome (stored, refreshed,
 *   create-deferred, tombstoned) — those are idempotent and ack normally.
 * - "none" means the frame carried no originator stamp at all.
 */
export type McpOriginatorDeliveryVerdict =
  | "admitted"
  | "denied_retryable"
  | "denied_permanent"
  | "none";

/**
 * Shared malformed-generation denial. The frame carried a generation that
 * failed shape validation; treating it as a legacy delivery would admit a
 * token beneath the generation contract, so deny fail-closed. The denial is
 * PERMANENT for this frame (the durable floor was never bumped for it, so a
 * later well-formed delivery still admits normally): redelivering the same
 * malformed bytes would loop forever. Log only the wire value's TYPE (and
 * string length), never the raw content — it is untrusted producer data and
 * could itself carry a bearer-shaped payload (evil-shub round-8 P1).
 */
function denyMalformedGeneration(
  frame: unknown,
  delivery: McpOriginatorParsedDelivery,
  context: string,
): "denied_permanent" {
  const rawGeneration = (frame as { mcp_originator_generation?: unknown })
    ?.mcp_originator_generation;
  console.error(
    `[MCP originator] run ${delivery.superRunId}: ${context}denying delivery with malformed generation (type=${typeof rawGeneration}${
      typeof rawGeneration === "string" ? ` length=${rawGeneration.length}` : ""
    })`,
  );
  return "denied_permanent";
}

/**
 * Volatile install half for a delivery the pre-commit gate ALREADY admitted
 * (evil-shub round-9 P1). Runs NO durable transaction and makes NO admission
 * decision: the gate's atomic admit (floor bump included) is the single
 * admission verdict for this frame, so the ack path can never flip committed
 * work to denied after the fact. A retirement racing the gap between gate
 * and install is fenced at use time by mcpOriginatorAuthorityPermitsUse,
 * which re-consults the durable authority on every token use.
 *
 * `allowCreate: false` restricts the delivery to refreshing an entry that
 * already exists; `mayRecreateOwner` is the narrow escape hatch (see
 * recordMcpOriginatorDelivery).
 */
export function installPreGatedMcpOriginatorDelivery(
  delivery: McpOriginatorParsedDelivery,
  options?: { allowCreate?: boolean; mayRecreateOwner?: () => boolean },
): void {
  if (!delivery.superRunId || delivery.malformedGeneration) return;
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
    // A live token entry is held: renew it against the server for exactly
    // as long as it stays held (the keepalive stops on tombstone, delete,
    // withdraw, or store clear).
    startMcpOriginatorKeepalive(
      delivery.superRunId,
      keepaliveHooks(delivery.superRunId),
    );
    return;
  }
  // Tokenless frame: clear stale authority, but never erase a generated
  // entry from beneath a known-newer contract (stale legacy/zombie clear),
  // and keep a tombstone so a later stale create cannot resurrect the key.
  // The gate's atomic admission already bumped the durable floor — even
  // when no entry exists — so a later zombie create cannot slip beneath
  // this generation.
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
  // Tombstoned: nothing live to renew anymore.
  stopMcpOriginatorKeepalive(delivery.superRunId);
}

export function recordMcpOriginatorDelivery(
  frame: unknown,
  options?: { allowCreate?: boolean; mayRecreateOwner?: () => boolean },
): McpOriginatorDeliveryVerdict {
  const delivery = readMcpOriginatorDelivery(frame);
  if (!delivery.superRunId) return "none";
  if (delivery.malformedGeneration) {
    return denyMalformedGeneration(frame, delivery, "");
  }
  // Atomic durable admission (evil-shub round-5 P1): gate + floor bump in
  // ONE locked transaction, consulted BEFORE the volatile entry check so an
  // empty Map inherits the floor. Rejects zombies below the max observed
  // generation, legacy deliveries beneath a known generation contract, and
  // any delivery for a headerless/terminal run (origin swap, mixed merge,
  // terminal retirement are never re-armed by duplicates). The floor is
  // advanced for EVERY admitted delivery before any create/refresh decision
  // below: if recreation is denied (transient live-owner proof failure),
  // the caller still ACKs the delivery; without the durable floor bump the
  // denied generation would be forgotten, and a later older zombie could
  // pass the gate and recreate the revoked entry once the proof path
  // recovers. A failed durable write denies admission entirely — the caller
  // must not ACK (redelivery retries the whole admission).
  const admission = admitMcpOriginatorDelivery(
    delivery.superRunId,
    delivery.generation,
  );
  if (!admission.admitted) {
    return admission.permanent ? "denied_permanent" : "denied_retryable";
  }
  installPreGatedMcpOriginatorDelivery(delivery, options);
  return "admitted";
}

/**
 * Pre-commit admission gate (evil-shub round-8 P1; sole admission decision
 * as of round-9 P1): evaluates ONLY the durable admission half of the
 * delivery path — parse, malformed check, and the atomic durable admit
 * (which bumps the generation floor) — without touching the volatile token
 * store. The input router runs this BEFORE the durable input
 * commit/enqueue/start so a denied frame never commits work it cannot be
 * authorized for, and hands the returned `delivery` to the ack path, which
 * installs it via installPreGatedMcpOriginatorDelivery with NO second
 * admission transaction — a re-admission at ack time could flip committed
 * work to denied when a retirement lands in the gate→ack gap (TOCTOU).
 * Retirement in that gap is instead fenced at use time by
 * mcpOriginatorAuthorityPermitsUse.
 */
export function gateMcpOriginatorDeliveryAdmission(frame: unknown): {
  verdict: McpOriginatorDeliveryVerdict;
  /**
   * The parsed delivery, present when (and only when) the verdict is
   * "admitted": exactly what the ack path must install.
   */
  delivery?: McpOriginatorParsedDelivery;
} {
  const delivery = readMcpOriginatorDelivery(frame);
  if (!delivery.superRunId) return { verdict: "none" };
  if (delivery.malformedGeneration) {
    return {
      verdict: denyMalformedGeneration(frame, delivery, "pre-commit gate "),
    };
  }
  const admission = admitMcpOriginatorDelivery(
    delivery.superRunId,
    delivery.generation,
  );
  if (!admission.admitted) {
    return {
      verdict: admission.permanent ? "denied_permanent" : "denied_retryable",
    };
  }
  return { verdict: "admitted", delivery };
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
    // Durable-first: the fail-closed boundary must be persisted BEFORE the
    // volatile entry is dropped. A process death in the gap between delete
    // and mark would leave no durable headerless record, letting a duplicate
    // recreate the token after restart. (evil-shub round 4)
    // Honor the durability boolean (evil-shub round-6 P1): when the mark
    // could not be persisted, deleting the volatile entry would pretend a
    // retirement the durable file does not know — after a restart the file
    // still shows the run live and a duplicate could recreate the token.
    // Keeping the entry is fail-safe: the in-memory mark already withdraws
    // it from use, and its keepalive renews a token no caller can obtain.
    if (markMcpOriginatorHeaderless(runId, generation)) {
      deleteMcpOriginatorToken(runId);
    } else {
      console.error(
        `[mcp-originator-tokens] headerless mark for ${runId} is NOT durable; keeping the volatile entry (unusable in this process) so restart cannot resurrect authority`,
      );
    }
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
  // Durable-first: terminal mark lands before the volatile delete (see the
  // origin-swap retire above).
  // Same durability contract as the origin-swap retire (evil-shub round-6
  // P1): no volatile delete without a durable terminal mark.
  if (markMcpOriginatorTerminal(superRunId, generation)) {
    deleteMcpOriginatorToken(superRunId);
  } else {
    console.error(
      `[mcp-originator-tokens] terminal mark for ${superRunId} is NOT durable; keeping the volatile entry (unusable in this process) so restart cannot resurrect authority`,
    );
  }
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
  // Durable-first: headerless mark lands before the volatile delete.
  if (markMcpOriginatorHeaderless(superRunId, generation)) {
    deleteMcpOriginatorToken(superRunId);
  } else {
    console.error(
      `[mcp-originator-tokens] mixed-merge headerless mark for ${superRunId} is NOT durable; keeping the volatile entry (unusable in this process) so restart cannot resurrect authority`,
    );
  }
}
