import type { AuthResult } from "@earendil-works/pi-ai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { getRegisteredPiProvider } from "@/backend/dev/pi-provider-mod-registry";
import {
  getPiProviderSpec,
  resolveProviderFromModelHandle,
  stripProviderHandlePrefix,
} from "@/backend/dev/pi-provider-registry";
import { debugWarn } from "@/utils/debug";
import {
  getLocalProviderRecordByName,
  LOCAL_PROVIDER_NO_API_KEY,
  type LocalProviderRecord,
} from "./local-provider-auth-store";

const OPENROUTER_USER_MODELS_TIMEOUT_MS = 5_000;
// Matches the availability cache TTL; staleness marks refetch sooner.
const OPENROUTER_USER_MODELS_TTL_MS = 5 * 60 * 1000;
const OPENROUTER_USER_MODELS_RETRY_MS = 30_000;
const OPENROUTER_CONNECTION_RETRIES = 2;

interface OpenRouterUserModelsConnection {
  baseURL: string;
  headers: Headers;
  /** Identity of the account and endpoint a fetched list belongs to. */
  signature: string;
}

function storedRecord(
  storageDir: string | undefined,
): LocalProviderRecord | undefined {
  for (const name of getPiProviderSpec("openrouter").localProviderNames) {
    const record = getLocalProviderRecordByName(name, storageDir);
    if (record) return record;
  }
  return undefined;
}

/**
 * Same connection the chat path uses: the runtime-resolved key (stored API
 * key, OAuth-issued key, or OPENROUTER_API_KEY), then base URL from the
 * resolved auth, the stored record, OPENROUTER_BASE_URL, and pi-ai's default.
 *
 * getAuth() reads the stored record on its own, so a provider update landing
 * mid-resolution could pair the old key with the new base URL. The record is
 * read before and after resolving auth and the pair is used only when both
 * reads agree; a record that keeps changing fails closed.
 */
async function resolveOpenRouterConnection(
  getAuth: () => Promise<AuthResult | undefined>,
  storageDir: string | undefined,
): Promise<OpenRouterUserModelsConnection | undefined> {
  const spec = getPiProviderSpec("openrouter");
  for (let attempt = 0; ; attempt++) {
    const before = JSON.stringify(storedRecord(storageDir) ?? null);
    const authResult = await getAuth();
    const record = storedRecord(storageDir);
    if (JSON.stringify(record ?? null) !== before) {
      if (attempt >= OPENROUTER_CONNECTION_RETRIES) {
        throw new Error(
          "OpenRouter connection changed repeatedly while resolving auth",
        );
      }
      continue;
    }
    const apiKey = authResult?.auth.apiKey;
    if (!apiKey || apiKey === LOCAL_PROVIDER_NO_API_KEY) return undefined;
    const baseURL =
      authResult.auth.baseUrl ??
      record?.base_url ??
      spec.baseUrlEnv?.() ??
      spec.defaultBaseURL ??
      openrouterProvider().baseUrl;
    if (!baseURL) return undefined;
    const headers = new Headers(spec.headers?.());
    for (const [name, value] of Object.entries(authResult.auth.headers ?? {})) {
      if (value !== null) headers.set(name, value);
    }
    headers.set("Accept", "application/json");
    headers.set("Authorization", `Bearer ${apiKey}`);
    return { baseURL, headers, signature: `${baseURL} ${apiKey}` };
  }
}

/**
 * Model ids the account may use, from OpenRouter's `GET /models/user`: the
 * catalog filtered by the account's provider preferences, privacy settings,
 * and guardrails (and by in-region routing on a regional hostname). Throws
 * on any transport, status, or shape failure.
 */
async function fetchOpenRouterUserModelIds(
  connection: OpenRouterUserModelsConnection,
  fetchImpl: typeof fetch,
): Promise<ReadonlySet<string>> {
  const url = `${connection.baseURL.replace(/\/+$/, "")}/models/user`;
  const response = await fetchImpl(url, {
    headers: connection.headers,
    signal: AbortSignal.timeout(OPENROUTER_USER_MODELS_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`GET ${url} returned HTTP ${response.status}`);
  }
  const body = (await response.json()) as { data?: unknown };
  if (!Array.isArray(body?.data)) {
    throw new Error(`GET ${url} returned no "data" array`);
  }
  return new Set(
    body.data.flatMap((entry) =>
      typeof (entry as { id?: unknown })?.id === "string"
        ? [(entry as { id: string }).id]
        : [],
    ),
  );
}

interface AccountModelsEntry {
  signature: string;
  ids?: ReadonlySet<string>;
  generation: number;
  /** Next time the list is considered due for a refetch. */
  refreshAt: number;
}

/**
 * Per-runtime cache of the OpenRouter account list, so every listing caller
 * (picker, startup, default-model and turn resolution) shares one fetch. A
 * failed refetch keeps the last good list for the same key and endpoint,
 * and waits before retrying; with no good list the catalog stays unfiltered.
 */
export class OpenRouterAccountModels {
  private entry?: AccountModelsEntry;
  private inflight?: {
    signature: string;
    promise: Promise<ReadonlySet<string> | undefined>;
  };
  private generation = 0;

  constructor(
    private readonly options: {
      getAuth: () => Promise<AuthResult | undefined>;
      storageDir?: string;
      fetchImpl?: typeof fetch;
    },
  ) {}

  /** The next read refetches; the last good list stays as a fallback. */
  markStale(): void {
    this.generation++;
    this.inflight = undefined;
  }

  /** Allowed model ids, or undefined when the account list is unknown. */
  async allowedModelIds(): Promise<ReadonlySet<string> | undefined> {
    // A mod that owns the openrouter id owns its catalog and endpoint.
    if (getRegisteredPiProvider("openrouter")) return undefined;
    try {
      const connection = await resolveOpenRouterConnection(
        this.options.getAuth,
        this.options.storageDir,
      );
      if (!connection) return undefined;
      const entry =
        this.entry?.signature === connection.signature ? this.entry : undefined;
      if (
        entry &&
        entry.generation === this.generation &&
        Date.now() < entry.refreshAt
      ) {
        return entry.ids;
      }
      if (this.inflight?.signature === connection.signature) {
        return await this.inflight.promise;
      }
      const promise = this.refetch(connection, entry?.ids);
      this.inflight = { signature: connection.signature, promise };
      try {
        return await promise;
      } finally {
        if (this.inflight?.promise === promise) this.inflight = undefined;
      }
    } catch (error) {
      debugWarn(
        "openrouter-user-models",
        "Could not resolve the OpenRouter connection",
        error instanceof Error ? error.message : String(error),
      );
      return undefined;
    }
  }

  private async refetch(
    connection: OpenRouterUserModelsConnection,
    lastKnown: ReadonlySet<string> | undefined,
  ): Promise<ReadonlySet<string> | undefined> {
    const generation = this.generation;
    let ids: ReadonlySet<string> | undefined;
    let refreshAt: number;
    try {
      ids = await fetchOpenRouterUserModelIds(
        connection,
        this.options.fetchImpl ?? fetch,
      );
      refreshAt = Date.now() + OPENROUTER_USER_MODELS_TTL_MS;
    } catch (error) {
      ids = lastKnown;
      refreshAt = Date.now() + OPENROUTER_USER_MODELS_RETRY_MS;
      debugWarn(
        "openrouter-user-models",
        lastKnown
          ? "Keeping the last OpenRouter account model list; refetch failed"
          : "Showing the full OpenRouter catalog; account model list unavailable",
        error instanceof Error ? error.message : String(error),
      );
    }
    // A fetch that started before markStale() must not displace a newer one.
    if (!this.entry || this.entry.generation <= generation) {
      this.entry = {
        signature: connection.signature,
        ...(ids ? { ids } : {}),
        generation,
        refreshAt,
      };
    }
    return ids;
  }
}

function openRouterModelId(handle: string): string | undefined {
  return resolveProviderFromModelHandle(handle) === "openrouter"
    ? stripProviderHandlePrefix(handle, "openrouter")
    : undefined;
}

/**
 * Drop OpenRouter catalog handles the account list does not allow. Other
 * providers' entries pass through. An unknown list, or one that would leave
 * no OpenRouter model, keeps the unfiltered catalog.
 */
export function filterOpenRouterModelsForAccount<T extends { handle: string }>(
  entries: T[],
  allowed: ReadonlySet<string> | undefined,
): T[] {
  if (!allowed) return entries;
  const hasOpenRouter = (list: T[]) =>
    list.some((entry) => openRouterModelId(entry.handle) !== undefined);
  if (!hasOpenRouter(entries)) return entries;
  const filtered = entries.filter((entry) => {
    const modelId = openRouterModelId(entry.handle);
    return modelId === undefined || allowed.has(modelId);
  });
  if (!hasOpenRouter(filtered)) {
    debugWarn(
      "openrouter-user-models",
      "Showing the full OpenRouter catalog; the account allows none of its models",
    );
    return entries;
  }
  return filtered;
}
