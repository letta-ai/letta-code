import { LETTA_CLOUD_API_URL } from "../../auth/oauth";
import { type Settings, settingsManager } from "../../settings-manager";

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
  /** Ephemeral proxy base URL used only for git transport. */
  proxyBaseUrl: string;
  /** Canonical memfs base URL that remains persisted in git config/settings. */
  memfsBaseUrl: string;
  /** Git URL prefix for the ephemeral transport. */
  proxyPrefix: string;
  /** Git URL prefix for the canonical remote. */
  memfsPrefix: string;
  /** Git config key for url.<proxyPrefix>.insteadOf. */
  configKey: string;
  /** Git config value for url.<proxyPrefix>.insteadOf. */
  configValue: string;
}

function trimBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

/**
 * Get the current Letta memfs server URL from environment or settings.
 * Falls back to Letta Cloud when no memfs-specific URL is set.
 *
 * Intentionally ignores LETTA_BASE_URL: Desktop sets LETTA_BASE_URL to an
 * ephemeral localhost proxy port, but MemFS git config/settings must stay
 * keyed by a stable canonical URL. Desktop's transient git transport proxy is
 * handled separately by LETTA_MEMFS_GIT_PROXY_BASE_URL.
 */
export function getMemfsServerUrl(): string {
  let settings: Settings | null = null;
  try {
    settings = settingsManager.getSettings();
  } catch {
    // Settings may be unavailable in isolated tests that only rely on env.
  }

  const configuredMemfsUrl =
    process.env.LETTA_MEMFS_BASE_URL || settings?.env?.LETTA_MEMFS_BASE_URL;
  if (configuredMemfsUrl) {
    return configuredMemfsUrl;
  }

  return LETTA_CLOUD_API_URL;
}

/**
 * Resolve Desktop's transient MemFS git proxy rewrite, if configured.
 *
 * LETTA_MEMFS_GIT_PROXY_BASE_URL is intentionally transport-only: it should
 * never be used for settings keys, persisted remotes, or credential helper
 * config. It lets Desktop route git network traffic through its localhost
 * proxy while keeping the local repo's origin canonical and stable.
 */
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
