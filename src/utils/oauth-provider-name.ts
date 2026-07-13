const OAUTH_PROVIDER_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

export function normalizeOAuthProviderName(
  providerName: string | null | undefined,
  defaultProviderName?: string,
): string {
  const normalized = (providerName ?? defaultProviderName ?? "").trim();
  if (!normalized) {
    throw new Error("OAuth provider name cannot be empty.");
  }
  if (!OAUTH_PROVIDER_NAME_PATTERN.test(normalized)) {
    throw new Error(
      "OAuth provider name may only contain letters, numbers, dots, underscores, and hyphens.",
    );
  }
  return normalized;
}
