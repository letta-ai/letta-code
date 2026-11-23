import { connectMcpServer } from "@/mcp-client";
import { createMcpOAuthSessionWithStorage } from "@/mcp-oauth";
import { mcpOAuthCredentialKey } from "@/mcp-oauth-identity";

export interface McpOAuthCredentialSnapshot {
  access_token: string;
  refresh_token?: string;
  client_id: string;
  client_secret?: string;
  redirect_uri: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
}

export interface McpOAuthStorage {
  get(
    credentialKey: string,
    signal: AbortSignal,
  ): Promise<string | null | undefined>;
  set(credentialKey: string, value: string, signal: AbortSignal): Promise<void>;
  delete(credentialKey: string, signal: AbortSignal): Promise<unknown>;
}

export type McpOAuthFetch = (
  url: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface AuthorizeMcpServerWithStorageOptions {
  agentId: string;
  storageNamespace: string;
  storage: McpOAuthStorage;
  serverName: string;
  serverUrl: string;
  fetch?: McpOAuthFetch;
  openBrowser?: (url: string) => Promise<void>;
  onStatus?: (message: string) => void;
  onAuthorizationCallback?: (callback: { domain?: string }) => void;
  clientName?: string;
  signal?: AbortSignal;
}

interface InFlightAuthorization {
  controller: AbortController;
  consumers: number;
  settled: boolean;
  promise: Promise<McpOAuthCredentialSnapshot>;
}

const inFlightAuthorizations = new Map<string, InFlightAuthorization>();
const fetchFunctionIds = new WeakMap<McpOAuthFetch, number>();
let nextFetchFunctionId = 1;

export async function authorizeMcpServerWithStorage(
  options: AuthorizeMcpServerWithStorageOptions,
): Promise<McpOAuthCredentialSnapshot> {
  options.signal?.throwIfAborted();
  if (
    !options.storageNamespace.trim() ||
    options.storageNamespace.includes("\0")
  ) {
    throw new Error(
      "MCP OAuth storage namespace must be non-empty and contain no NUL bytes",
    );
  }
  const credentialKey = mcpOAuthCredentialKey(
    options.agentId,
    options.serverName,
    options.serverUrl,
  );
  const flightKey = `${options.storageNamespace}\0${credentialKey}\0${fetchIdentity(options.fetch)}\0${options.clientName ?? ""}`;
  let flight = inFlightAuthorizations.get(flightKey);
  if (!flight) {
    const controller = new AbortController();
    let newFlight: InFlightAuthorization;
    const promise = runAuthorization(
      options,
      credentialKey,
      controller.signal,
    ).finally(() => {
      newFlight.settled = true;
      if (inFlightAuthorizations.get(flightKey) === newFlight) {
        inFlightAuthorizations.delete(flightKey);
      }
    });
    newFlight = {
      controller,
      consumers: 0,
      settled: false,
      promise,
    };
    flight = newFlight;
    inFlightAuthorizations.set(flightKey, flight);
  }
  return subscribeToAuthorization(flightKey, flight, options.signal);
}

async function runAuthorization(
  options: AuthorizeMcpServerWithStorageOptions,
  credentialKey: string,
  signal: AbortSignal,
): Promise<McpOAuthCredentialSnapshot> {
  const storage = abortableStorage(options.storage, signal);
  const creating = createMcpOAuthSessionWithStorage({
    credentialKey,
    storageNamespace: options.storageNamespace,
    storage,
    interactive: true,
    openBrowser: options.openBrowser,
    onStatus: options.onStatus,
    onAuthorizationCallback: options.onAuthorizationCallback,
    clientName: options.clientName,
  });
  let oauth: Awaited<typeof creating>;
  try {
    oauth = await withAbort(creating, signal);
  } catch (error) {
    void creating
      .then((lateSession) => lateSession?.close())
      .catch(() => undefined);
    throw error;
  }
  if (!oauth) throw new Error("MCP OAuth session was not created");

  let connection: Awaited<ReturnType<typeof connectMcpServer>> | undefined;
  const cancel = () => {
    void oauth.close().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    connection = await connectMcpServer(
      {
        name: options.serverName,
        transport: "http",
        url: options.serverUrl,
      },
      { fetch: options.fetch, oauth, signal },
    );
    return await withAbort(oauth.exportCredentials(), signal);
  } finally {
    signal.removeEventListener("abort", cancel);
    await Promise.allSettled([connection?.close(), oauth.close()]);
  }
}

function fetchIdentity(fetchFn?: McpOAuthFetch): string {
  if (!fetchFn) return "default";
  let id = fetchFunctionIds.get(fetchFn);
  if (id === undefined) {
    id = nextFetchFunctionId;
    nextFetchFunctionId += 1;
    fetchFunctionIds.set(fetchFn, id);
  }
  return String(id);
}

function abortableStorage(storage: McpOAuthStorage, signal: AbortSignal) {
  return {
    get: (credentialKey: string) =>
      runStorageOperation(() => storage.get(credentialKey, signal), signal),
    set: (credentialKey: string, value: string) =>
      runStorageOperation(
        () => storage.set(credentialKey, value, signal),
        signal,
      ),
    delete: (credentialKey: string) =>
      runStorageOperation(() => storage.delete(credentialKey, signal), signal),
  };
}

function runStorageOperation<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  return withAbort(operation(), signal);
}

function subscribeToAuthorization(
  flightKey: string,
  flight: InFlightAuthorization,
  signal?: AbortSignal,
): Promise<McpOAuthCredentialSnapshot> {
  flight.consumers += 1;
  const release = (): void => {
    flight.consumers -= 1;
    if (!flight.settled && flight.consumers === 0) {
      if (inFlightAuthorizations.get(flightKey) === flight) {
        inFlightAuthorizations.delete(flightKey);
      }
      flight.controller.abort();
    }
  };
  return new Promise((resolve, reject) => {
    let settled = false;
    const abort = () => {
      if (settled) return;
      settled = true;
      release();
      reject(
        signal?.reason ?? new DOMException("Operation aborted", "AbortError"),
      );
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    void flight.promise.then(
      (credentials) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", abort);
        release();
        resolve({ ...credentials });
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", abort);
        release();
        reject(error);
      },
    );
  });
}

async function withAbort<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return operation;
  signal.throwIfAborted();
  let abort: (() => void) | undefined;
  const cancellation = new Promise<never>((_resolve, reject) => {
    abort = () => {
      reject(
        signal.reason ?? new DOMException("Operation aborted", "AbortError"),
      );
    };
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([operation, cancellation]);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}
