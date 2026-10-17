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
 * Consumer side only: this module does not verify tokens, enforce ACLs, or
 * decide attribution. When no token is held for a run, callers simply omit
 * the header and the call proceeds unattributed.
 */
const tokensBySuperRunId = new Map<string, string>();

/** Record (or refresh) the originator token for a super run. */
export function setMcpOriginatorToken(superRunId: string, token: string): void {
  tokensBySuperRunId.set(superRunId, token);
}

/**
 * Resolve the held token for a super run, or undefined when the run is
 * unattributed (no token delivered) or the token was already dropped.
 */
export function getMcpOriginatorToken(
  superRunId: string | null | undefined,
): string | undefined {
  if (!superRunId) return undefined;
  return tokensBySuperRunId.get(superRunId);
}

/** Drop the token for a super run that reached a terminal state. */
export function deleteMcpOriginatorToken(superRunId: string): void {
  tokensBySuperRunId.delete(superRunId);
}

/** Drop every held token (listener session teardown, tests). */
export function clearMcpOriginatorTokens(): void {
  tokensBySuperRunId.clear();
}

/** Presence-only diagnostic: how many runs currently hold a token. */
export function mcpOriginatorTokenCount(): number {
  return tokensBySuperRunId.size;
}

/**
 * Extract the originator delivery from an inbound top-level run-input frame.
 *
 * This is the single parse site for the relay contract fields. Wire data is
 * untrusted: present-but-malformed values are treated as absent (the turn
 * then runs unattributed) rather than rejecting the whole input.
 */
export function readMcpOriginatorDelivery(payload: unknown): {
  superRunId?: string;
  token?: string;
} {
  const wire =
    typeof payload === "object" && payload !== null
      ? (payload as {
          super_run_id?: unknown;
          mcp_originator_token?: unknown;
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
  return {
    ...(superRunId ? { superRunId } : {}),
    ...(token ? { token } : {}),
  };
}

/**
 * Apply an accepted input's originator delivery to the store.
 *
 * Call only once the input has been ACCEPTED (queued or started); tokens
 * belonging to rejected or dropped inputs must never reach the store. The
 * frame is authoritative about the run's current token state:
 * - id + token: record/refresh (the producer re-mints per delivery and
 *   revokes the prior token, so last-write-wins keeps the live one).
 * - id without token: clear any stale token held for the run. A tokenless
 *   redelivery must not silently reuse authority minted for an earlier
 *   delivery of the same super run id.
 *
 * `allowCreate: false` (duplicate re-acks and accepted approval/teleport
 * payloads — accepts that create no new owning turn) restricts the delivery
 * to refreshing an entry that already exists. Without that gate a duplicate
 * re-ack arriving AFTER the owning turn's finalizer retired its token would
 * re-insert an orphaned token that no finalizer will ever clean up, and an
 * origin-swap deletion would stop being a stable boundary: any late
 * redelivery could repopulate the deleted key while a cross-origin
 * continuation is running.
 */
export function recordMcpOriginatorDelivery(
  frame: unknown,
  options?: { allowCreate?: boolean },
): void {
  const delivery = readMcpOriginatorDelivery(frame);
  if (!delivery.superRunId) return;
  if (delivery.token) {
    if (
      options?.allowCreate === false &&
      !tokensBySuperRunId.has(delivery.superRunId)
    ) {
      return;
    }
    setMcpOriginatorToken(delivery.superRunId, delivery.token);
  } else {
    deleteMcpOriginatorToken(delivery.superRunId);
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
  if (turnSuperRunId) deleteMcpOriginatorToken(turnSuperRunId);
  if (queuedSuperRunId) deleteMcpOriginatorToken(queuedSuperRunId);
}
