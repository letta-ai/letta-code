import type {
  AuthOperationOptions,
  Credential,
  CredentialStore,
} from "@earendil-works/pi-ai";
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
} from "./local-provider-auth-store";

/**
 * pi-ai CredentialStore over Letta's local provider records (auth.json),
 * keyed by pi-ai provider id. This makes the Models runtime the credential
 * source of truth: `Models.getAuth()` reads stored keys/OAuth tokens from
 * here and persists OAuth refreshes back through `modify`, which is
 * serialized per provider as the contract requires so concurrent requests
 * cannot double-refresh a rotated token. An active mutation that is cancelled
 * releases the queue, but its late callback result is fenced from persistence.
 * (auth.json writes are same-process only today; cross-process locking would
 * live in the auth store itself.)
 *
 * Records store more than credentials (base URLs, timeouts, regions) —
 * that remains Letta-owned provider config; only the credential facet is
 * exposed through this adapter, and provider-specific OAuth fields (e.g.
 * GitHub Copilot's enterpriseUrl) round-trip untouched.
 */

/** Local auth.json record names that serve a pi-ai provider id. */
export function localNamesForProviderId(providerId: string): readonly string[] {
  const registered = getRegisteredPiProvider(providerId);
  if (registered) {
    // A mod overriding a built-in provider id keeps that provider's local
    // record aliases (e.g. "openai-codex" still reads "chatgpt-plus-pro").
    return getRegisteredPiProviderLocalNames(registered);
  }
  if (isPiProvider(providerId)) {
    return getPiProviderSpec(providerId).localProviderNames;
  }
  return [providerId];
}

/** Maps a stored record name back to the pi-ai provider id it serves. */
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
    // Preserve provider-specific fields (enterpriseUrl, accountId, ...);
    // pi-ai reads them during refresh and toAuth.
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
  // Per-provider mutation queue: `modify`/`delete` for the same provider run
  // in sequence, except an actively cancelled callback releases its successor
  // while its own eventual result remains fenced from persistence.
  const mutationQueues = new Map<string, Promise<unknown>>();
  function serialized<T>(
    providerId: string,
    run: () => Promise<T>,
    signal?: AbortSignal,
    canReleaseOnActiveAbort: () => boolean = () => true,
  ): Promise<T> {
    const previous = mutationQueues.get(providerId) ?? Promise.resolve();
    let started = false;
    const start = () => {
      signal?.throwIfAborted();
      started = true;
      return run();
    };
    const operation = previous.then(
      () => start(),
      () => start(),
    );
    const next = raceCredentialMutationWithAbort(operation, signal);
    const tail = credentialMutationQueueTail(
      operation,
      signal,
      () => started && canReleaseOnActiveAbort(),
    );
    mutationQueues.set(providerId, tail);
    void tail.then(() => {
      if (mutationQueues.get(providerId) === tail) {
        mutationQueues.delete(providerId);
      }
    });
    return next;
  }

  const read = async (
    providerId: string,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> => {
    options?.signal?.throwIfAborted();
    const record = recordForProviderId(providerId, storageDir);
    return record ? credentialFromRecord(record) : undefined;
  };

  return {
    read,
    async list(options) {
      options?.signal?.throwIfAborted();
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
    modify(providerId, fn, options) {
      let commitStarted = false;
      return serialized(
        providerId,
        async () => {
          options?.signal?.throwIfAborted();
          const record = recordForProviderId(providerId, storageDir);
          const current = record ? credentialFromRecord(record) : undefined;
          const next = await fn(current);
          // A legacy mod callback may ignore its optional signal. The caller and
          // provider mutation queue still release on abort, but this underlying
          // promise remains observed. Fence its late result before persistence.
          options?.signal?.throwIfAborted();
          if (next === undefined) return current;
          const providerName =
            record?.name ??
            localNamesForProviderId(providerId)[0] ??
            providerId;
          if (next.type === "oauth") {
            commitStarted = true;
            setLocalOAuthProvider({
              providerName,
              providerType: record?.provider_type ?? providerId,
              auth: localOAuthAuthFromCredentials(next),
              storageDir,
            });
            return next;
          }
          if (next.key) {
            commitStarted = true;
            // Read-modify-write: every non-credential record field survives
            // (createOrUpdateLocalProvider keeps base URL/timeout itself, but
            // Bedrock's access key/region/profile must be re-supplied).
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
        },
        options?.signal,
        () => !commitStarted,
      );
    },
    delete(providerId, options) {
      let deleteStarted = false;
      return serialized(
        providerId,
        async () => {
          options?.signal?.throwIfAborted();
          const record = recordForProviderId(providerId, storageDir);
          if (record) {
            deleteStarted = true;
            await removeLocalProviderByName(record.name, storageDir);
          }
        },
        options?.signal,
        () => !deleteStarted,
      );
    },
  };
}

function raceCredentialMutationWithAbort<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) {
    void operation.catch(() => {});
    return Promise.reject(signal.reason);
  }

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function credentialMutationQueueTail<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
  canReleaseOnAbort: () => boolean,
): Promise<void> {
  if (!signal)
    return operation.then(
      () => {},
      () => {},
    );

  return new Promise((resolve) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    const onAbort = () => {
      // A queued operation must keep waiting on its active predecessor. An
      // operation already committing to storage must also settle before its
      // successor starts, because that side effect cannot be rolled back.
      if (canReleaseOnAbort()) settle();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    operation.then(settle, settle);
  });
}
