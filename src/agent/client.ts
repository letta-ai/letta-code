import Letta from "@letta-ai/letta-client";
import { refreshAccessToken } from "../auth/oauth";
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
        console.error("Refreshing expired access token...");
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
        console.error("Access token refreshed successfully");
      } catch (error) {
        console.error("Failed to refresh access token:", error);
        console.error("Please run 'letta login' to re-authenticate");
        process.exit(1);
      }
    }
  }


  const baseURL =
    process.env.LETTA_BASE_URL ||
    settings.env?.LETTA_BASE_URL ||
    "https://api.letta.com";


  if (!apiKey && baseURL === "https://api.letta.com") {
    console.error("Missing LETTA_API_KEY");
    console.error("Run 'letta setup' to configure authentication");
    process.exit(1);
  }

  // Auto-cache: if env vars are set but not in settings, write them to settings
  let needsUpdate = false;
  const updatedEnv = { ...settings.env };

  if (process.env.LETTA_API_KEY && !settings.env?.LETTA_API_KEY) {
    updatedEnv.LETTA_API_KEY = process.env.LETTA_API_KEY;
    needsUpdate = true;
  }

  if (process.env.LETTA_BASE_URL && !settings.env?.LETTA_BASE_URL) {
    updatedEnv.LETTA_BASE_URL = process.env.LETTA_BASE_URL;
    needsUpdate = true;
  }

  if (needsUpdate) {
    settingsManager.updateSettings({ env: updatedEnv });
  }

  return new Letta({ apiKey, baseURL });
}
