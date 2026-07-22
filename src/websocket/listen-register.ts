/**
 * Shared registration helper for letta server / /server command.
 * Owns the HTTP request contract and error handling; callers own UX strings and logging.
 */

import { createHash, randomUUID } from "node:crypto";
import { getSelfUpdateStatus } from "@/updater/auto-update";
import { getVersion } from "@/version.ts";
import { SUPPORTED_REMOTE_COMMANDS } from "./listener/listener-constants";

/**
 * Per-process registration nonce (unique for this process lifetime, NOT
 * stable across restarts). The relay records which process owns each
 * connection lease; when a newer registration supersedes this process, the
 * relay tombstones this nonce and rejects our re-registration attempts with
 * 409 LISTENER_SUPERSEDED instead of letting us steal the lease back
 * (LET-10024). Servers that predate the field ignore it.
 */
const PROCESS_INSTANCE_ID = `proc-${randomUUID()}`;

export function getListenerProcessInstanceId(): string {
  return PROCESS_INSTANCE_ID;
}

export interface RegisterResult {
  connectionId: string;
  wsUrl: string;
  supportsSplitStatusChannels: boolean;
}

export interface RegisterOptions {
  serverUrl: string;
  apiKey: string;
  deviceId: string;
  connectionName: string;
  /**
   * Stable identifier for this listener process, so multiple listeners on
   * one device (e.g. `letta server` in a terminal plus the in-app /listen
   * command) get separate Cloud environment rows instead of contesting a
   * single per-device row and rotating each other's connection lease.
   * Optional: servers that predate the field ignore it.
   */
  listenerInstanceId?: string;
}

/**
 * Listener surfaces. Each (surface, connectionName) combination maps to its
 * own environment slot on the relay, so listeners spawned by different
 * owners coexist instead of contesting one lease — e.g. a Desktop-spawned
 * cloud listener and a manual `letta server` that both default to
 * hostname() as the connection name (LET-10024).
 *
 * - "server": manual `letta server` / `letta remote` CLI process
 * - "listen": in-app /listen command
 * - "desktop-remote": Desktop-spawned direct-Cloud listener (Desktop passes
 *   LETTA_LISTENER_SURFACE=desktop-remote to the child; inferring from
 *   command shape would regress silently)
 */
export type ListenerSurface = "server" | "listen" | "desktop-remote";

const LISTENER_SURFACES: readonly ListenerSurface[] = [
  "server",
  "listen",
  "desktop-remote",
];

/**
 * Resolve the surface for a spawned listener process. The spawner (e.g.
 * Desktop) declares it explicitly via LETTA_LISTENER_SURFACE; unset or
 * unknown values fall back to the caller's default.
 */
export function resolveListenerSurfaceFromEnv(
  fallback: ListenerSurface,
): ListenerSurface {
  const raw = process.env.LETTA_LISTENER_SURFACE;
  return LISTENER_SURFACES.includes(raw as ListenerSurface)
    ? (raw as ListenerSurface)
    : fallback;
}

/**
 * Derive a stable listener instance id from the listener surface and its
 * connection name. Deterministic (no stored state): the same surface + name
 * maps to the same instance across restarts, while a rename creates a new
 * instance (the old row ages out server-side via lastSeenAt).
 */
export function deriveListenerInstanceId(
  surface: ListenerSurface,
  connectionName: string,
): string {
  const nameHash = createHash("sha256")
    .update(connectionName)
    .digest("hex")
    .slice(0, 16);
  return `${surface}-${nameHash}`;
}

type FetchImpl = typeof fetch;

/**
 * Error thrown by registration that carries the HTTP status code (if any).
 * Network errors (fetch failure) have `statusCode = 0`.
 */
export class RegistrationError extends Error {
  readonly statusCode: number;
  readonly retryAfterMs?: number;
  readonly errorCode?: string;
  constructor(
    message: string,
    statusCode: number,
    retryAfterMs?: number,
    errorCode?: string,
  ) {
    super(message);
    this.name = "RegistrationError";
    this.statusCode = statusCode;
    this.retryAfterMs = retryAfterMs;
    this.errorCode = errorCode;
  }
}

/**
 * True when registration was rejected because this process's lease was
 * superseded by a newer listener (relay returned 409 LISTENER_SUPERSEDED).
 * Terminal: the process must stop, not retry or re-register.
 */
export function isSupersededRegistrationError(error: unknown): boolean {
  return (
    error instanceof RegistrationError &&
    error.statusCode === 409 &&
    (error.errorCode === "LISTENER_SUPERSEDED" ||
      error.message.includes("LISTENER_SUPERSEDED"))
  );
}

/** Returns true for errors that are likely transient and worth retrying. */
function isTransientRegistrationError(error: unknown): boolean {
  if (error instanceof RegistrationError) {
    // 429 = rate limit. The server explicitly asked us to slow down, not stop.
    // 5xx = server errors (including Cloudflare 521/522/523/524)
    // 0 = network-level failure (DNS, TCP, TLS)
    return (
      error.statusCode === 0 ||
      error.statusCode === 429 ||
      error.statusCode >= 500
    );
  }
  // Non-RegistrationError from fetch (e.g. TypeError for DNS failure)
  return true;
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }

  return undefined;
}

/**
 * Register this device with the Letta Cloud environments endpoint.
 * Throws on any failure with an error message suitable for wrapping in caller-specific context.
 */
export async function registerWithCloud(
  opts: RegisterOptions,
  fetchImpl: FetchImpl = fetch,
): Promise<RegisterResult> {
  const registerUrl = `${opts.serverUrl}/v1/environments/register`;

  const response = await fetchImpl(registerUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.apiKey}`,
      "X-Letta-Source": "letta-code",
    },
    body: JSON.stringify({
      deviceId: opts.deviceId,
      ...(opts.listenerInstanceId
        ? { listenerInstanceId: opts.listenerInstanceId }
        : {}),
      processInstanceId: PROCESS_INSTANCE_ID,
      connectionName: opts.connectionName,
      metadata: {
        lettaCodeVersion: getVersion(),
        os: process.platform,
        nodeVersion: process.version,
        environmentMessageProtocol: "v2-input",
        supported_commands: SUPPORTED_REMOTE_COMMANDS,
        self_update: getSelfUpdateStatus(),
      },
    }),
  }).catch((fetchError: unknown) => {
    // Network-level failures (DNS, TCP, TLS, etc.)
    const msg =
      fetchError instanceof Error ? fetchError.message : String(fetchError);
    throw new RegistrationError(`Network error: ${msg}`, 0);
  });

  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    let errorCode: string | undefined;
    const retryAfterMs = parseRetryAfterMs(response.headers.get("Retry-After"));
    const text = await response.text().catch(() => "");
    if (text) {
      try {
        const parsed = JSON.parse(text) as {
          error?: string;
          errorCode?: string;
          message?: string;
        };
        errorCode = parsed.errorCode;
        if (parsed.message) {
          detail = parsed.message;
          if (parsed.errorCode) {
            detail += ` (${parsed.errorCode})`;
          }
        } else if (parsed.error) {
          detail = `HTTP ${response.status}: ${parsed.error}`;
          if (parsed.errorCode) {
            detail += ` (${parsed.errorCode})`;
          }
        } else {
          detail += `: ${text.slice(0, 200)}`;
        }
      } catch {
        detail += `: ${text.slice(0, 200)}`;
      }
    }
    throw new RegistrationError(
      detail,
      response.status,
      retryAfterMs,
      errorCode,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new RegistrationError(
      "Server returned non-JSON response — is the server running?",
      response.status,
    );
  }

  const result = body as Record<string, unknown>;
  if (
    typeof result.connectionId !== "string" ||
    typeof result.wsUrl !== "string"
  ) {
    throw new RegistrationError(
      "Server returned unexpected response shape (missing connectionId or wsUrl)",
      response.status,
    );
  }

  return {
    connectionId: result.connectionId,
    wsUrl: result.wsUrl,
    supportsSplitStatusChannels: result.supportsSplitStatusChannels === true,
  };
}

const REGISTER_INITIAL_DELAY_MS = 1_000;
const REGISTER_MAX_DELAY_MS = 30_000;
const REGISTER_MAX_DURATION_MS = 2 * 60 * 1_000; // 2 minutes
const REGISTER_MAX_JITTER_MS = 1_000;
const REGISTER_JITTER_RATIO = 0.25;

export interface RegisterRetryCallbacks {
  /** Called before each retry attempt. */
  onRetry?: (attempt: number, delayMs: number, error: Error) => void;
  /** Maximum total retry duration. Defaults to two minutes. Use Infinity for long-running listeners. */
  maxDurationMs?: number;
  /** Test seam for avoiding real sleeps. */
  sleep?: (delayMs: number) => Promise<void>;
  /** Test seam for injecting fetch. */
  fetchImpl?: FetchImpl;
  /** Test seam for deterministic retry jitter. */
  random?: () => number;
}

/**
 * Register with Cloud, retrying on transient errors (429, 5xx, network failures)
 * with exponential backoff. Fails immediately on other client errors (4xx).
 */
export async function registerWithCloudRetry(
  opts: RegisterOptions,
  callbacks?: RegisterRetryCallbacks,
): Promise<RegisterResult> {
  const startTime = Date.now();
  const maxDurationMs = callbacks?.maxDurationMs ?? REGISTER_MAX_DURATION_MS;
  const sleep =
    callbacks?.sleep ??
    ((delayMs: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  let attempt = 0;

  for (;;) {
    try {
      return await registerWithCloud(opts, callbacks?.fetchImpl);
    } catch (error) {
      const elapsed = Date.now() - startTime;

      if (!isTransientRegistrationError(error) || elapsed >= maxDurationMs) {
        throw error;
      }

      attempt++;
      const backoffDelay = Math.min(
        REGISTER_INITIAL_DELAY_MS * 2 ** (attempt - 1),
        REGISTER_MAX_DELAY_MS,
      );
      const delay =
        error instanceof RegistrationError && error.retryAfterMs !== undefined
          ? Math.max(error.retryAfterMs, backoffDelay)
          : backoffDelay;
      const jitterWindow = Math.min(
        REGISTER_MAX_JITTER_MS,
        Math.floor(delay * REGISTER_JITTER_RATIO),
      );
      const jitter =
        jitterWindow > 0
          ? Math.floor((callbacks?.random ?? Math.random)() * jitterWindow)
          : 0;
      const retryDelay = delay + jitter;

      if (error instanceof Error) {
        callbacks?.onRetry?.(attempt, retryDelay, error);
      }

      await sleep(retryDelay);
    }
  }
}
