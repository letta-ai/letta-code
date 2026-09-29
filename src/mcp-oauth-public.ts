import { connectMcpServer } from "@/mcp-client";
import {
  createMcpOAuthSessionWithStorage,
  mcpOAuthCredentialKey,
} from "@/mcp-oauth";

/** Credentials produced by a completed MCP OAuth flow. */
export interface McpOAuthCredentialSnapshot {
  access_token: string;
  refresh_token?: string;
  client_id: string;
  client_secret?: string;
  redirect_uri: string;
  token_type?: string;
  /** Remaining access-token lifetime in seconds at export time. */
  expires_in?: number;
  scope?: string;
}

/** Async persistence for completed MCP OAuth credentials. */
export interface McpOAuthStorage {
  get(credentialKey: string): Promise<string | null | undefined>;
  set(credentialKey: string, value: string): Promise<void>;
  delete(credentialKey: string): Promise<unknown>;
}

/** Options for one complete, single-flight MCP OAuth authorization. */
export interface AuthorizeMcpServerWithStorageOptions {
  /** Owning agent used to namespace the credential key. */
  agentId: string;
  /** Stable identity for the physical backend, account, and profile. */
  storageNamespace: string;
  storage: McpOAuthStorage;
  serverName: string;
  serverUrl: string;
  openBrowser?: (url: string) => Promise<void>;
  onStatus?: (message: string) => void;
  signal?: AbortSignal;
}

interface InFlightAuthorization {
  controller: AbortController;
  consumers: number;
  settled: boolean;
  promise: Promise<McpOAuthCredentialSnapshot>;
}

const inFlightAuthorizations = new Map<string, InFlightAuthorization>();

/**
 * Authorize and validate one HTTP MCP server, then return importable credentials.
 *
 * Calls for the same storage namespace, agent, and server share one in-flight
 * SDK authorization lifecycle. Aborting one subscriber does not interrupt
 * another; the underlying operation is cancelled when its final subscriber
 * leaves. A storage namespace must remain stable for wrappers around the same
 * physical backend and unique across physically distinct backends.
 */
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
  const flightKey = `${options.storageNamespace}\0${credentialKey}`;
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
  return subscribeToAuthorization(flight, options.signal);
}

async function runAuthorization(
  options: AuthorizeMcpServerWithStorageOptions,
  credentialKey: string,
  signal: AbortSignal,
): Promise<McpOAuthCredentialSnapshot> {
  const creating = createMcpOAuthSessionWithStorage({
    credentialKey,
    storageNamespace: options.storageNamespace,
    storage: options.storage,
    interactive: true,
    openBrowser: options.openBrowser,
    onStatus: options.onStatus,
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
      { oauth, signal },
    );
    return await withAbort(oauth.exportCredentials(), signal);
  } finally {
    signal.removeEventListener("abort", cancel);
    await Promise.allSettled([connection?.close(), oauth.close()]);
  }
}

function subscribeToAuthorization(
  flight: InFlightAuthorization,
  signal?: AbortSignal,
): Promise<McpOAuthCredentialSnapshot> {
  flight.consumers += 1;
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    flight.consumers -= 1;
    if (!flight.settled && flight.consumers === 0) flight.controller.abort();
  };
  return withAbort(flight.promise, signal).then(
    (credentials) => {
      release();
      return { ...credentials };
    },
    (error: unknown) => {
      release();
      throw error;
    },
  );
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
