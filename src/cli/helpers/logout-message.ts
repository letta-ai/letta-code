const ENV_API_KEY_NOTE = [
  "Note: LETTA_API_KEY is still set in your shell or system environment.",
  "/logout does not clear environment variables. Remove it manually if you",
  "want to stop authenticating with that key.",
].join("\n");

export const LOGOUT_REVOKE_FAILED_MESSAGE = [
  "⚠ Cleared local credentials, but the server-side revoke failed.",
  "To finish signing out, revoke the authorization in the Letta app under",
  "Settings > Profile > Connected Applications.",
].join("\n");

export function buildLogoutSuccessMessage(hasEnvApiKey: boolean): string {
  if (!hasEnvApiKey) {
    return "✓ Logged out successfully. Run 'letta' to re-authenticate.";
  }

  return ["✓ Cleared saved Letta credentials.", "", ENV_API_KEY_NOTE].join(
    "\n",
  );
}

/**
 * Message shown when local credentials were cleared but the server could not
 * confirm the revoke, so the user knows to revoke it manually.
 */
export function buildLogoutRevokeFailedMessage(options: {
  hasEnvApiKey: boolean;
  localAgentLabel?: string;
}): string {
  const parts = [LOGOUT_REVOKE_FAILED_MESSAGE];
  if (options.localAgentLabel) {
    parts.push(
      `You're still using your local agent ${options.localAgentLabel}.`,
    );
  }
  if (options.hasEnvApiKey) {
    parts.push(ENV_API_KEY_NOTE);
  }
  return parts.join("\n\n");
}

/**
 * Final /logout message. Unchanged when the server revoke succeeded; when it
 * failed, tells the user to revoke the authorization manually.
 */
export function buildLogoutMessage(options: {
  hasEnvApiKey: boolean;
  revokeFailed: boolean;
  localAgentLabel?: string;
}): string {
  const { hasEnvApiKey, revokeFailed, localAgentLabel } = options;
  if (revokeFailed) {
    return buildLogoutRevokeFailedMessage({ hasEnvApiKey, localAgentLabel });
  }
  if (localAgentLabel) {
    const baseMessage = `Logged out successfully. You're still using your local agent ${localAgentLabel}.`;
    return hasEnvApiKey
      ? `${baseMessage}\n\n${buildLogoutSuccessMessage(true)}`
      : baseMessage;
  }
  return buildLogoutSuccessMessage(hasEnvApiKey);
}

/**
 * Revoke the stored token on the server (if any), then always clear local
 * credentials. Returns whether the server-side revoke failed.
 */
export async function revokeAndClearCredentials(options: {
  refreshToken?: string | null;
  revokeToken: (refreshToken: string) => Promise<boolean>;
  clearLocalCredentials: () => Promise<void>;
}): Promise<{ revokeFailed: boolean }> {
  let revokeFailed = false;
  if (options.refreshToken) {
    revokeFailed = !(await options.revokeToken(options.refreshToken));
  }
  await options.clearLocalCredentials();
  return { revokeFailed };
}
