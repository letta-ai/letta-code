import { settingsManager } from "../../settings-manager";

/**
 * Subcommand: `letta logout`
 *
 * Clears all stored authentication credentials (API key, refresh token,
 * OAuth tokens) so the user is prompted to re-authenticate on next launch.
 *
 * Useful when an API key is rotated/revoked or to switch accounts.
 */
export async function runLogoutSubcommand(_args: string[]): Promise<number> {
  try {
    await settingsManager.logout();
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Logout failed: ${message}`);
    return 1;
  }
}
