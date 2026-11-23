import { LETTA_CLOUD_API_URL } from "@/auth/oauth";
import { type Settings, settingsManager } from "@/settings-manager";

function isLocalhostUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

export const LETTA_MEMFS_GIT_PROXY_BASE_URL_ENV =
  "LETTA_MEMFS_GIT_PROXY_BASE_URL";

export interface MemfsGitProxyRewriteConfig {
  proxyBaseUrl: string;
  memfsBaseUrl: string;
  proxyPrefix: string;
  memfsPrefix: string;
  configKey: string;
  configValue: string;
}

function trimBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

export function getMemfsServerUrl(): string {
  let settings: Settings | null = null;
  try {
    settings = settingsManager.getSettings();
  } catch {}

  const configuredMemfsUrl =
    process.env.LETTA_MEMFS_BASE_URL || settings?.env?.LETTA_MEMFS_BASE_URL;
  if (configuredMemfsUrl) {
    return configuredMemfsUrl;
  }

  return LETTA_CLOUD_API_URL;
}

export function getMemfsGitProxyRewriteConfig(
  env: NodeJS.ProcessEnv = process.env,
): MemfsGitProxyRewriteConfig | null {
  const rawProxyBaseUrl = env[LETTA_MEMFS_GIT_PROXY_BASE_URL_ENV]?.trim();
  if (!rawProxyBaseUrl || !isLocalhostUrl(rawProxyBaseUrl)) {
    return null;
  }

  const memfsBaseUrl = trimBaseUrl(getMemfsServerUrl());
  if (!memfsBaseUrl.includes("api.letta.com")) {
    return null;
  }

  const proxyBaseUrl = trimBaseUrl(rawProxyBaseUrl);
  const proxyPrefix = `${proxyBaseUrl}/v1/git/`;
  const memfsPrefix = `${memfsBaseUrl}/v1/git/`;

  return {
    proxyBaseUrl,
    memfsBaseUrl,
    proxyPrefix,
    memfsPrefix,
    configKey: `url.${proxyPrefix}.insteadOf`,
    configValue: memfsPrefix,
  };
}
