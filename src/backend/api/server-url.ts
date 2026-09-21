import { LETTA_CLOUD_API_URL } from "@/auth/oauth";
import { settingsManager } from "@/settings-manager";

/**
 * Get the current Letta server URL from environment or settings.
 * Used for cache keys and API operations.
 */
export function getServerUrl(): string {
  const settings = settingsManager.getSettings();
  return (
    process.env.LETTA_BASE_URL ||
    settings.env?.LETTA_BASE_URL ||
    LETTA_CLOUD_API_URL
  );
}

/**
 * True when the configured server is Letta Cloud (matched by hostname).
 * Cloud-only concepts such as computers/environment routing key off this.
 */
export function isCloudServerUrl(serverUrl?: string): boolean {
  let resolved = serverUrl;
  if (resolved === undefined) {
    try {
      resolved = getServerUrl();
    } catch {
      // Settings may not be initialized yet (e.g. early capability reads).
      resolved = process.env.LETTA_BASE_URL || LETTA_CLOUD_API_URL;
    }
  }
  try {
    const parsed = new URL(resolved);
    const cloud = new URL(LETTA_CLOUD_API_URL);
    return parsed.hostname === cloud.hostname;
  } catch {
    return false;
  }
}
