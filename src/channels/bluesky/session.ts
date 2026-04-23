/**
 * JWT session management for the Bluesky adapter.
 *
 * Encapsulates the three ways we can end up with a live session:
 *   1. Existing access JWT that hasn't expired — reuse.
 *   2. Refresh JWT that hasn't expired — call `refreshSession`.
 *   3. Everything else — call `createSession` with the app password.
 *
 * Fetches happen through the local `fetchWithTimeout` helper so a hung
 * PDS can't wedge the poll loop.
 */

import type { BlueskySession } from "./types";
import { decodeJwtExp, fetchWithTimeout, getServiceUrl } from "./utils";

const EXPIRY_SKEW_MS = 60_000;

export interface BlueskySessionCreds {
  handle: string;
  appPassword: string;
  serviceUrl?: string;
}

export interface EnsureSessionResult {
  session: BlueskySession;
  /** True when we performed a fresh `createSession` (caller should persist). */
  refreshed: boolean;
}

function isExpired(expiresAt: number | undefined): boolean {
  if (typeof expiresAt !== "number") return false;
  return Date.now() + EXPIRY_SKEW_MS >= expiresAt;
}

function applySession(data: {
  accessJwt: string;
  refreshJwt: string;
  did: string;
  handle?: string;
}): BlueskySession {
  return {
    did: data.did,
    handle: data.handle ?? "",
    accessJwt: data.accessJwt,
    refreshJwt: data.refreshJwt,
    accessExpiresAt: decodeJwtExp(data.accessJwt),
    refreshExpiresAt: decodeJwtExp(data.refreshJwt),
  };
}

/**
 * Perform `com.atproto.server.createSession` with handle + app password.
 * Throws when the server rejects the credentials.
 */
export async function createSession(
  creds: BlueskySessionCreds,
): Promise<BlueskySession> {
  const url = `${getServiceUrl(creds.serviceUrl)}/xrpc/com.atproto.server.createSession`;
  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      identifier: creds.handle,
      password: creds.appPassword,
    }),
  });

  if (!res.ok) {
    const detail = await safeReadBody(res);
    throw new Error(
      `Bluesky createSession failed (${res.status}): ${detail || res.statusText}`,
    );
  }

  const body = (await res.json()) as {
    accessJwt: string;
    refreshJwt: string;
    did: string;
    handle?: string;
  };
  return applySession(body);
}

/**
 * Perform `com.atproto.server.refreshSession` with the stored refresh JWT.
 * Caller should fall back to `createSession` on failure.
 */
export async function refreshSession(params: {
  refreshJwt: string;
  serviceUrl?: string;
}): Promise<BlueskySession> {
  const url = `${getServiceUrl(params.serviceUrl)}/xrpc/com.atproto.server.refreshSession`;
  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${params.refreshJwt}`,
    },
  });

  if (!res.ok) {
    const detail = await safeReadBody(res);
    throw new Error(
      `Bluesky refreshSession failed (${res.status}): ${detail || res.statusText}`,
    );
  }

  const body = (await res.json()) as {
    accessJwt: string;
    refreshJwt: string;
    did: string;
    handle?: string;
  };
  return applySession(body);
}

/**
 * Return a usable session — refreshing or re-creating as needed.
 *
 * `existing` lets the adapter hand in the session it loaded from disk so
 * that warm starts avoid a `createSession` round-trip.
 */
export async function ensureSession(params: {
  creds: BlueskySessionCreds;
  existing?: BlueskySession;
}): Promise<EnsureSessionResult> {
  const { creds, existing } = params;

  if (existing?.accessJwt && !isExpired(existing.accessExpiresAt)) {
    return { session: existing, refreshed: false };
  }

  if (existing?.refreshJwt && !isExpired(existing.refreshExpiresAt)) {
    try {
      const session = await refreshSession({
        refreshJwt: existing.refreshJwt,
        serviceUrl: creds.serviceUrl,
      });
      return {
        session: {
          ...session,
          // Preserve the handle we authenticated with, since refresh responses
          // sometimes omit it.
          handle: session.handle || existing.handle,
        },
        refreshed: true,
      };
    } catch {
      // fall through to createSession
    }
  }

  const session = await createSession(creds);
  return {
    session: {
      ...session,
      handle: session.handle || creds.handle,
    },
    refreshed: true,
  };
}

async function safeReadBody(res: Response): Promise<string | undefined> {
  try {
    const text = await res.text();
    return text.slice(0, 400);
  } catch {
    return undefined;
  }
}
