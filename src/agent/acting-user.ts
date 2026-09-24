/**
 * Header the listener echoes back to cloud-api so it can re-attribute
 * requests to the human who actually initiated them (rather than the
 * user whose API key spawned the sandbox / desktop runtime).
 *
 * Cloud-api stamps `acting_user_id` and a principal-bound assertion onto
 * relayed WS frames. The listener echoes both on corresponding outbound HTTP
 * calls, and Cloud verifies the assertion before applying delegated access.
 */
export const ACTING_USER_ID_HEADER = "X-Letta-Acting-User-Id";
export const ACTING_USER_ASSERTION_HEADER = "X-Letta-Acting-User-Assertion";
export const ACTING_USER_ID_ENV = "LETTA_ACTING_USER_ID";
export const ACTING_USER_ASSERTION_ENV = "LETTA_ACTING_USER_ASSERTION";

export function resolveActingUserId(
  explicitActingUserId?: string,
  runtimeActingUserId?: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return explicitActingUserId ?? runtimeActingUserId ?? env[ACTING_USER_ID_ENV];
}

/**
 * Build per-request options carrying the acting-user header, or
 * undefined when no acting user is present (self-hosted / direct
 * flows), so call sites can spread it without conditionals.
 */
export function resolveActingUserAssertion(
  explicitAssertion?: string,
  runtimeAssertion?: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return (
    explicitAssertion ?? runtimeAssertion ?? env[ACTING_USER_ASSERTION_ENV]
  );
}

export function resolveActingUserRuntimeScope(): {
  acting_user_id?: string;
  acting_user_assertion?: string;
} {
  const actingUserId = resolveActingUserId();
  const actingUserAssertion = resolveActingUserAssertion();
  return {
    ...(actingUserId ? { acting_user_id: actingUserId } : {}),
    ...(actingUserId && actingUserAssertion
      ? { acting_user_assertion: actingUserAssertion }
      : {}),
  };
}

export function actingUserRequestOptions(
  actingUserId: string | undefined,
  actingUserAssertion?: string,
): { headers: Record<string, string> } | undefined {
  if (!actingUserId) {
    return undefined;
  }
  return {
    headers: {
      [ACTING_USER_ID_HEADER]: actingUserId,
      ...(actingUserAssertion
        ? { [ACTING_USER_ASSERTION_HEADER]: actingUserAssertion }
        : {}),
    },
  };
}
