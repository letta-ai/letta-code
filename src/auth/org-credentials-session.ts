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

  async getAccessToken(): Promise<string> {
    if (this.pending) return this.pending;
    const credentials = this.current;
    if (!needsRefresh(credentials) || !credentials.refreshToken) {
      return credentials.apiKey;
    }
    const pending = this.refresh(credentials, credentials.refreshToken);
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
  ): Promise<string> {
    const now = Date.now();
    try {
      const tokens = await refreshAccessTokenSingleFlight(
        refreshToken,
        this.deviceId,
        this.deviceName,
        this.refreshTokens,
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
export function getOrgAccessToken(): Promise<string> | undefined {
  return session?.getAccessToken();
}

/**
 * The credential a process-level session owns, if any: the organization
 * sign-in for `letta server --org`, else the Desktop token. Undefined means
 * the caller should fall through to the ambient key and the global sign-in.
 */
export async function getSessionAccessToken(): Promise<string | undefined> {
  return (await getOrgAccessToken()) ?? getDesktopAccessToken();
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
