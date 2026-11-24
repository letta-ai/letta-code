import type { Credential, CredentialStore } from "@earendil-works/pi-ai";
import { getRegisteredPiProvider } from "@/backend/dev/pi-provider-mod-registry";
import {
  getPiProviderSpec,
  isPiProvider,
  PI_PROVIDER_SPECS,
} from "@/backend/dev/pi-provider-registry";
import { getRegisteredPiProviderLocalNames } from "@/backend/dev/registered-pi-provider-runtime";
import {
  createOrUpdateLocalProvider,
  getLocalProviderRecordByName,
  type LocalProviderRecord,
  listLocalProviderRecords,
  localOAuthAuthFromCredentials,
  localProviderApiKeyFromRecord,
  removeLocalProviderByName,
  setLocalOAuthProvider,
  withLocalProviderAuthLock,
} from "./local-provider-auth-store";

export function localNamesForProviderId(providerId: string): readonly string[] {
  const registered = getRegisteredPiProvider(providerId);
  if (registered) {
    return getRegisteredPiProviderLocalNames(registered);
  }
  if (isPiProvider(providerId)) {
    return getPiProviderSpec(providerId).localProviderNames;
  }
  return [providerId];
}

function providerIdForRecordName(recordName: string): string {
  const registered = getRegisteredPiProvider(recordName);
  if (registered) return registered.providerName;
  const spec = PI_PROVIDER_SPECS.find((entry) =>
    entry.localProviderNames.includes(recordName),
  );
  return spec ? (spec.piProvider ?? spec.id) : recordName;
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
    const { type: _type, ...oauthFields } = record.auth;
    return {
      ...oauthFields,
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
  const mutationQueues = new Map<string, Promise<unknown>>();
  function serialized<T>(
    providerId: string,
    body: () => Promise<T>,
  ): Promise<T> {
    const run = () => withLocalProviderAuthLock(body, storageDir);
    const previous = mutationQueues.get(providerId) ?? Promise.resolve();
    const next = previous.then(run, run);
    mutationQueues.set(
      providerId,
      next.catch(() => {}),
    );
    return next;
  }

  const read = async (providerId: string): Promise<Credential | undefined> => {
    const record = recordForProviderId(providerId, storageDir);
    return record ? credentialFromRecord(record) : undefined;
  };

  return {
    read,
    async list() {
      return listLocalProviderRecords(storageDir).flatMap((record) => {
        const credential = credentialFromRecord(record);
        return credential
          ? [
              {
                providerId: providerIdForRecordName(record.name),
                type: credential.type,
              },
            ]
          : [];
      });
    },
    modify(providerId, fn) {
      return serialized(providerId, async () => {
        const record = recordForProviderId(providerId, storageDir);
        const current = record ? credentialFromRecord(record) : undefined;
        const next = await fn(current);
        if (next === undefined) return current;
        const providerName =
          record?.name ?? localNamesForProviderId(providerId)[0] ?? providerId;
        if (next.type === "oauth") {
          setLocalOAuthProvider({
            providerName,
            providerType: record?.provider_type ?? providerId,
            auth: localOAuthAuthFromCredentials(next),
            storageDir,
          });
          return next;
        }
        if (next.key) {
          await createOrUpdateLocalProvider({
            providerName,
            providerType: record?.provider_type ?? providerId,
            apiKey: next.key,
            ...(record?.access_key ? { accessKey: record.access_key } : {}),
            ...(record?.region ? { region: record.region } : {}),
            ...(record?.profile ? { profile: record.profile } : {}),
            storageDir,
          });
        }
        return next;
      });
    },
    delete(providerId) {
      return serialized(providerId, async () => {
        const record = recordForProviderId(providerId, storageDir);
        if (record) await removeLocalProviderByName(record.name, storageDir);
      });
    },
  };
}
