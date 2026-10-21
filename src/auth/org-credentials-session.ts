import { hostname } from "node:os";
import { getDesktopAccessToken } from "@/auth/desktop-credentials";
import { refreshAccessToken } from "@/auth/oauth";
import { refreshAccessTokenSingleFlight } from "@/auth/oauth-refresh";
import {
  type OrgCredentials,
  orgCredentialStore,
} from "@/websocket/listener/org-credentials";

/**
 * Refresh this far ahead of expiry so an in-flight request never carries a
 * token that dies mid-call. Same window the listener uses on reconnect.
 */
const ORG_TOKEN_REFRESH_WINDOW_MS = 5 * 60 * 1000;

type SignedIn = OrgCredentials & { apiKey: string };
type RefreshAccessToken = typeof refreshAccessToken;

/**
 * Release an awaited promise when the caller's abort signal fires
 * (evil-shub round-9 P1). A JOINER of an in-flight refresh cannot cancel
 * the underlying fetch — other waiters may hold it — but without this race
 * the joiner awaits a promise it does not control with no bound at all
 * (OrgCredentialSession.pending accumulates immortal waiters while the
 * keepalive tick guard is held). The underlying promise keeps running to
 * settlement; both handlers are attached from the start so its late
 * settlement or rejection is consumed and never surfaces unhandled.
 */
function raceWithSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(abortError(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(abortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error
    ? reason
    : new Error(
        `[org-credentials-session] access-token wait aborted${
          reason === undefined ? "" : `: ${String(reason)}`
        }`,
      );
}

/**
 * A `letta server --org` process signs in to one organization. Every
 * credential reader in the process (API client, memfs git, subagents, shell
 * env) consults this session before the ambient `LETTA_API_KEY` or the global
 * sign-in, so turns run as the organization the computer registered in.
 * Modeled on the Desktop credential session: undefined means an ordinary
 * process, never a fallback.
 */
export class OrgCredentialSession {
  private current: SignedIn;
  private pending: Promise<string> | null = null;

  constructor(
    readonly organizationId: string,
    private readonly deviceId: string,
    credentials: SignedIn,
    private readonly deviceName: string = hostname(),
    private readonly refreshTokens: RefreshAccessToken = refreshAccessToken,
  ) {
    this.current = credentials;
  }

  /** The listener resolved or refreshed the sign-in; keep readers current. */
  update(credentials: SignedIn): void {
    this.current = credentials;
  }

  /** Last known token, for readers that cannot await (shell env, scrubbing). */
  peekAccessToken(): string {
    return this.current.apiKey;
  }

  async getAccessToken(options?: { signal?: AbortSignal }): Promise<string> {
    // Joiner: the in-flight refresh may have been started without a signal
    // by someone else — await it bounded by OUR budget rather than not at
    // all. The starter path needs no race: its signal reaches the fetch
    // itself, so the pending promise settles when the budget fires.
    if (this.pending) return raceWithSignal(this.pending, options?.signal);
    const credentials = this.current;
    if (!needsRefresh(credentials) || !credentials.refreshToken) {
      return credentials.apiKey;
    }
    const pending = this.refresh(
      credentials,
      credentials.refreshToken,
      options?.signal,
    );
    this.pending = pending;
    try {
      return await pending;
    } finally {
      if (this.pending === pending) this.pending = null;
    }
  }

  private async refresh(
    credentials: SignedIn,
    refreshToken: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const now = Date.now();
    try {
      const tokens = await refreshAccessTokenSingleFlight(
        refreshToken,
        this.deviceId,
        this.deviceName,
        this.refreshTokens,
        signal !== undefined ? { signal } : undefined,
      );
      const next: SignedIn = {
        apiKey: tokens.access_token,
        refreshToken: tokens.refresh_token ?? refreshToken,
        tokenExpiresAt: now + tokens.expires_in * 1000,
      };
      this.current = next;
      await orgCredentialStore.save(this.organizationId, next);
      return next.apiKey;
    } catch (error) {
      // A still-valid token outlives a flaky refresh; the listener's reconnect
      // path retries the refresh and surfaces a dead one.
      if (
        credentials.tokenExpiresAt === undefined ||
        now < credentials.tokenExpiresAt
      ) {
        return credentials.apiKey;
      }
      throw error;
    }
  }
}

function needsRefresh(credentials: OrgCredentials): boolean {
  return (
    credentials.tokenExpiresAt !== undefined &&
    Date.now() >= credentials.tokenExpiresAt - ORG_TOKEN_REFRESH_WINDOW_MS
  );
}

let session: OrgCredentialSession | null = null;

/**
 * Called by the listener each time it signs in or refreshes with `--org`.
 * The first call makes this an organization process; later calls keep the
 * in-process token aligned with what the listener just wrote to the slot.
 */
export function activateOrgCredentials(
  organizationId: string,
  deviceId: string,
  credentials: SignedIn,
  refresh: RefreshAccessToken = refreshAccessToken,
): void {
  if (session?.organizationId === organizationId) {
    session.update(credentials);
    return;
  }
  session = new OrgCredentialSession(
    organizationId,
    deviceId,
    credentials,
    undefined,
    refresh,
  );
}

/** Undefined means an ordinary CLI process, never an organization fallback. */
export function getOrgAccessToken(options?: {
  signal?: AbortSignal;
}): Promise<string> | undefined {
  return session?.getAccessToken(options);
}

/**
 * The credential a process-level session owns, if any: the organization
 * sign-in for `letta server --org`, else the Desktop token. Undefined means
 * the caller should fall through to the ambient key and the global sign-in.
 */
export async function getSessionAccessToken(options?: {
  signal?: AbortSignal;
}): Promise<string | undefined> {
  return (await getOrgAccessToken(options)) ?? getDesktopAccessToken();
}

/** Sync counterpart for readers that cannot await; may lag one refresh. */
export function peekOrgAccessToken(): string | undefined {
  return session?.peekAccessToken();
}

/**
 * SDK authHeaders reads apiKey per request, including on retained clients.
 * Serve the last known organization token there so a refresh made between
 * requests is picked up without rebuilding the client.
 */
export function bindOrgCredentials<T extends { apiKey: string | null }>(
  client: T,
): T {
  if (session) {
    Object.defineProperty(client, "apiKey", {
      get: peekOrgAccessToken,
      configurable: false,
    });
  }
  return client;
}

export const __orgCredentialsTestUtils = {
  reset(): void {
    session = null;
  },
};
