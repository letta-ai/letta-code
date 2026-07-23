import type { Credential, CredentialStore } from "@earendil-works/pi-ai";
import { getRegisteredPiProvider } from "@/backend/dev/pi-provider-mod-registry";
import {
  getPiProviderSpec,
  isPiProvider,
} from "@/backend/dev/pi-provider-registry";
import {
  getLocalProviderRecordByName,
  type LocalProviderRecord,
  listLocalProviderRecords,
  localOAuthAuthFromCredentials,
  localProviderApiKeyFromRecord,
  removeLocalProviderByName,
  setLocalOAuthProvider,
} from "./local-provider-auth-store";

/**
 * pi-ai CredentialStore over Letta's local provider records (auth.json),
 * keyed by pi-ai provider id. This makes the Models runtime the credential
 * source of truth: `Models.getAuth()` reads stored keys/OAuth tokens from
 * here and persists OAuth refreshes back under the store's write lock.
 *
 * Records store more than credentials (base URLs, timeouts, regions) —
 * that remains Letta-owned provider config; only the credential facet is
 * exposed through this adapter.
 */

function localNamesForProviderId(providerId: string): readonly string[] {
  const registered = getRegisteredPiProvider(providerId);
  if (registered) return [registered.providerName];
  if (isPiProvider(providerId)) {
    return getPiProviderSpec(providerId).localProviderNames;
  }
  return [providerId];
}

function recordForProviderId(
  providerId: string,
  storageDir?: string,
): LocalProviderRecord | undefined {
  for (const name of localNamesForProviderId(providerId)) {
    const record = getLocalProviderRecordByName(name, storageDir);
    if (record) return record;
  }
  return undefined;
}

function credentialFromRecord(
  record: LocalProviderRecord,
): Credential | undefined {
  if (record.auth.type === "oauth") {
    return {
      type: "oauth",
      access: record.auth.access,
      refresh: record.auth.refresh ?? "",
      expires: record.auth.expires,
    };
  }
  const key = localProviderApiKeyFromRecord(record);
  return key ? { type: "api_key", key } : undefined;
}

export function createLocalPiCredentialStore(
  storageDir?: string,
): CredentialStore {
  const read = async (providerId: string): Promise<Credential | undefined> => {
    const record = recordForProviderId(providerId, storageDir);
    return record ? credentialFromRecord(record) : undefined;
  };

  return {
    read,
    async list() {
      return listLocalProviderRecords(storageDir).flatMap((record) => {
        const credential = credentialFromRecord(record);
        // Record names map back to pi provider ids ambiguously for aliased
        // names; report under the stored record name, which pi-ai treats as
        // opaque metadata for status enumeration.
        return credential
          ? [{ providerId: record.name, type: credential.type }]
          : [];
      });
    },
    async modify(providerId, fn) {
      const record = recordForProviderId(providerId, storageDir);
      const current = record ? credentialFromRecord(record) : undefined;
      const next = await fn(current);
      if (next === undefined) return current;
      if (next.type === "oauth") {
        setLocalOAuthProvider({
          providerName:
            record?.name ??
            localNamesForProviderId(providerId)[0] ??
            providerId,
          providerType: record?.provider_type ?? providerId,
          auth: localOAuthAuthFromCredentials(next),
          storageDir,
        });
        return next;
      }
      // API keys are written through Letta's connect flows, which capture
      // provider config (base URL, timeouts) beyond the credential; a bare
      // key write here would drop that context. pi-ai only writes api_key
      // credentials from login flows, which Letta routes through /connect.
      return next;
    },
    async delete(providerId) {
      const record = recordForProviderId(providerId, storageDir);
      if (record) await removeLocalProviderByName(record.name, storageDir);
    },
  };
}
