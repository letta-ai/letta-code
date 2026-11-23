import { hostname } from "node:os";
import { getDesktopAccessToken } from "@/auth/desktop-credentials";
import { refreshAccessToken } from "@/auth/oauth";
import { refreshAccessTokenSingleFlight } from "@/auth/oauth-refresh";
import {
  type OrgCredentials,
  orgCredentialStore,
} from "@/websocket/listener/org-credentials";

const ORG_TOKEN_REFRESH_WINDOW_MS = 5 * 60 * 1000;

type SignedIn = OrgCredentials & { apiKey: string };
type RefreshAccessToken = typeof refreshAccessToken;

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

  update(credentials: SignedIn): void {
    this.current = credentials;
  }

  peekAccessToken(): string {
    return this.current.apiKey;
  }

  async getAccessToken(options?: { signal?: AbortSignal }): Promise<string> {
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

export function getOrgAccessToken(options?: {
  signal?: AbortSignal;
}): Promise<string> | undefined {
  return session?.getAccessToken(options);
}

export async function getSessionAccessToken(options?: {
  signal?: AbortSignal;
}): Promise<string | undefined> {
  return (await getOrgAccessToken(options)) ?? getDesktopAccessToken();
}

export function peekOrgAccessToken(): string | undefined {
  return session?.peekAccessToken();
}

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
