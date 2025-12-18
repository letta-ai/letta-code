import { hostname } from "node:os";
import Letta from "@letta-ai/letta-client";
import packageJson from "../../package.json";
import { LETTA_CLOUD_API_URL, refreshAccessToken } from "../auth/oauth";
import { settingsManager } from "../settings-manager";

export async function getClient() {
  const settings = await settingsManager.getSettingsWithSecureTokens();

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
        // Get or generate device ID (should always exist, but fallback just in case)
        let deviceId = settings.deviceId;
        if (!deviceId) {
          deviceId = crypto.randomUUID();
          settingsManager.updateSettings({ deviceId });
        }
        const deviceName = hostname();

        const tokens = await refreshAccessToken(
          settings.refreshToken,
          deviceId,
          deviceName,
        );

        // Update settings with new token (secrets handles secure storage automatically)
        settingsManager.updateSettings({
          env: { ...settings.env, LETTA_API_KEY: tokens.access_token },
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

  if (!apiKey && baseURL === LETTA_CLOUD_API_URL) {
    console.error("Missing LETTA_API_KEY");
    console.error(
      "Run 'letta setup' to configure authentication or set your LETTA_API_KEY environment variable",
    );
    process.exit(1);
  }

  return new Letta({
    apiKey,
    baseURL,
    defaultHeaders: {
      "X-Letta-Source": "letta-code",
      "User-Agent": `letta-code/${packageJson.version}`,
    },
  });
}
