import type { Backend } from "@/backend/backend";
import type { ModProviderCredentials } from "@/mods/types";

/**
 * Update provider credentials on the active backend.
 *
 * For local backends, writes directly to the local provider auth store.
 * For API backends, updates the provider through the BYOK provider API.
 */
export async function updateProviderCredentials(
  _backend: Backend,
  providerName: string,
  credentials: ModProviderCredentials,
): Promise<void> {
  if (credentials.oauth) {
    const { setLocalOAuthProvider } = await import(
      "@/backend/local/local-provider-auth-store"
    );
    const oauth = credentials.oauth;
    setLocalOAuthProvider({
      providerName,
      providerType: "chatgpt_oauth",
      auth: {
        type: "oauth",
        access: oauth.access_token,
        refresh: oauth.refresh_token,
        idToken: oauth.id_token,
        expires: oauth.expires_at,
        accountId: oauth.account_id,
      },
    });
    return;
  }

  if (credentials.apiKey !== undefined) {
    const { createOrUpdateLocalProvider, getLocalProviderRecordByName } =
      await import("@/backend/local/local-provider-auth-store");
    const existing = getLocalProviderRecordByName(providerName);
    await createOrUpdateLocalProvider({
      providerType: existing?.provider_type ?? "openai",
      providerName,
      apiKey: credentials.apiKey,
      baseURL: existing?.base_url,
    });
    return;
  }
}
