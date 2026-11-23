import { getServerHealth } from "./backend/api/health";
import { getServerUrl } from "./backend/api/server-url";
import { isVersionBelow } from "./utils/version";

const MINIMUM_DOCKER_VERSION = "0.16.6";

export async function startDockerVersionCheck(): Promise<void> {
  const baseURL = getServerUrl();

  if (baseURL.includes("api.letta.com")) {
    return;
  }

  try {
    const data = await getServerHealth({
      baseUrl: baseURL,
      signal: AbortSignal.timeout(3000),
    });
    const serverVersion = data.version;

    if (!serverVersion) return;

    if (isVersionBelow(serverVersion, MINIMUM_DOCKER_VERSION)) {
      console.warn(
        `\n⚠️  Warning: Your Docker image is outdated (v${serverVersion}). Minimum recommended: v${MINIMUM_DOCKER_VERSION}.\n   Please update with: docker pull letta/letta:latest\n`,
      );
    }
  } catch {}
}
