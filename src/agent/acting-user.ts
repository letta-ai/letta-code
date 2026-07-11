/**
 * Header the listener echoes back to cloud-api so it can re-attribute
 * requests to the human who actually initiated them (rather than the
 * user whose API key spawned the sandbox / desktop runtime).
 *
 * Cloud-api stamps `acting_user_id` onto relayed WS frames
 * (`input` create_message, `execute_command`, `conversation_create`);
 * the listener echoes the value on the corresponding outbound HTTP
 * call. Cloud-api validates listener origin + org membership before
 * honoring it (see tryApplyActingUserOverride in cloud-api).
 */
export const ACTING_USER_ID_HEADER = "X-Letta-Acting-User-Id";

/**
 * Build per-request options carrying the acting-user header, or
 * undefined when no acting user is present (self-hosted / direct
 * flows), so call sites can spread it without conditionals.
 */
export function actingUserRequestOptions(
  actingUserId: string | undefined,
): { headers: Record<string, string> } | undefined {
  if (!actingUserId) {
    return undefined;
  }
  return { headers: { [ACTING_USER_ID_HEADER]: actingUserId } };
}
