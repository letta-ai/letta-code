import { getServerUrl } from "./agent/client";
import { settingsManager } from "./settings-manager";

const MINIMUM_DOCKER_VERSION = "0.16.6";

import { isVersionBelow } from "./utils/version";

/**
 * Check if the Docker image version meets minimum requirements
 * For self-hosted users only - warns if version is outdated
 */
export async function startDockerVersionCheck(): Promise<void> {
  const baseURL = getServerUrl();

  // Only check for self-hosted servers
  if (baseURL.includes("api.letta.com")) {
    return;
  }

  try {
    const settings = await settingsManager.getSettingsWithSecureTokens();
    const apiKey =
      process.env.LETTA_API_KEY || settings.env?.LETTA_API_KEY || "";

    // Fetch server version with timeout
    const res = await fetch(`${baseURL}/v1/health`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(3000),
    });

    if (!res.ok) return;

    const data = (await res.json()) as { version?: string };
    const serverVersion = data.version;

    if (!serverVersion) return;

    // Check if version is below minimum
    if (isVersionBelow(serverVersion, MINIMUM_DOCKER_VERSION)) {
      console.warn(
        `\n⚠️  Warning: Your Docker image is outdated (v${serverVersion}). Minimum recommended: v${MINIMUM_DOCKER_VERSION}.\n   Please update with: docker pull letta/letta-server:latest\n`,
      );
    }
  } catch {
    // Best-effort - don't block startup
  }
}
