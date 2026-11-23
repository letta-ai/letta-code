import { LETTA_CLOUD_API_URL } from "@/auth/oauth";
import { settingsManager } from "@/settings-manager";

export function getServerUrl(): string {
  const settings = settingsManager.getSettings();
  return (
    process.env.LETTA_BASE_URL ||
    settings.env?.LETTA_BASE_URL ||
    LETTA_CLOUD_API_URL
  );
}

export function isCloudServerUrl(serverUrl?: string): boolean {
  let resolved = serverUrl;
  if (resolved === undefined) {
    try {
      resolved = getServerUrl();
    } catch {
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
