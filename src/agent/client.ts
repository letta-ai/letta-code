import Letta from "@letta-ai/letta-client";
import { LETTA_CLOUD_API_URL, refreshAccessToken } from "../auth/oauth";
import { settingsManager } from "../settings-manager";

export async function getClient() {
  const settings = settingsManager.getSettings();

  let apiKey = process.env.LETTA_API_KEY || settings.env?.LETTA_API_KEY;

  // Check if token is expired and refresh if needed
  if (
    !process.env.LETTA_API_KEY &&
    settings.tokenExpiresAt &&
    settings.refreshToken
  ) {
    const now = Date.now();
    const expiresAt = settings.tokenExpiresAt;

    // Refresh if token expires within 5 minutes
    if (expiresAt - now < 5 * 60 * 1000) {
      try {
        const tokens = await refreshAccessToken(settings.refreshToken);

        // Update settings with new token
        const updatedEnv = { ...settings.env };
        updatedEnv.LETTA_API_KEY = tokens.access_token;

        settingsManager.updateSettings({
          env: updatedEnv,
          refreshToken: tokens.refresh_token || settings.refreshToken,
          tokenExpiresAt: now + tokens.expires_in * 1000,
        });

        apiKey = tokens.access_token;
      } catch (error) {
        console.error("Failed to refresh access token:", error);
        console.error("Please run 'letta login' to re-authenticate");
        process.exit(1);
      }
    }
  }

  // Check if refresh token is missing for Letta Cloud
  const baseURL =
    process.env.LETTA_BASE_URL ||
    settings.env?.LETTA_BASE_URL ||
    LETTA_CLOUD_API_URL;

  if (baseURL === LETTA_CLOUD_API_URL && !settings.refreshToken) {
    console.error("Missing refresh token for Letta Cloud");
    console.error(
      "Run 'letta setup' to configure authentication or set your LETTA_API_KEY environment variable",
    );
    process.exit(1);
  }

  if (!apiKey && baseURL === LETTA_CLOUD_API_URL) {
    console.error("Missing LETTA_API_KEY");
    console.error(
      "Run 'letta setup' to configure authentication or set your LETTA_API_KEY environment variable",
    );
    process.exit(1);
  }

  // Auto-cache: if LETTA_API_KEY is set in env but not in settings, write it to settings
  // Note: LETTA_BASE_URL is intentionally NOT cached - it should only come from env vars
  if (process.env.LETTA_API_KEY && !settings.env?.LETTA_API_KEY) {
    const updatedEnv = { ...settings.env };
    updatedEnv.LETTA_API_KEY = process.env.LETTA_API_KEY;
    settingsManager.updateSettings({ env: updatedEnv });
  }

  return new Letta({
    apiKey,
    baseURL,
    defaultHeaders: { "X-Letta-Source": "letta-code" },
  });
}
