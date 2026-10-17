/**
 * In-memory store for MCP originator tokens (USER_SCOPED_MCP_CONNECTIONS).
 *
 * The cloud relay delivers a short-lived originator token on the run-input
 * payload (`mcp_originator_token`, alongside `super_run_id`) when the super
 * run is attributed to a principal. The listener forwards that token as the
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
import type { InputCreateMessagePayload } from "@/types/protocol_v2";

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
 * Extract the originator delivery from an inbound run-input payload.
 *
 * This is the single parse site for the relay contract fields. Wire data is
 * untrusted: present-but-malformed values are treated as absent (the turn
 * then runs unattributed) rather than rejecting the whole input.
 */
export function readMcpOriginatorDelivery(
  payload: Pick<
    InputCreateMessagePayload,
    "mcp_originator_token" | "super_run_id"
  >,
): { superRunId?: string; token?: string } {
  const superRunId =
    typeof payload.super_run_id === "string" && payload.super_run_id.length > 0
      ? payload.super_run_id
      : undefined;
  const token =
    typeof payload.mcp_originator_token === "string" &&
    payload.mcp_originator_token.length > 0
      ? payload.mcp_originator_token
      : undefined;
  return {
    ...(superRunId ? { superRunId } : {}),
    ...(token ? { token } : {}),
  };
}
