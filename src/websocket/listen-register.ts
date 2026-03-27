/**
 * Shared registration helper for letta server / /server command.
 * Owns the HTTP request contract and error handling; callers own UX strings and logging.
 */
import { getVersion } from "../version.ts";

export interface RegisterResult {
  connectionId: string;
  wsUrl: string;
}

export interface RegisterOptions {
  serverUrl: string;
  apiKey: string;
  deviceId: string;
  connectionName: string;
}

/**
 * Error thrown by registration that carries the HTTP status code (if any).
 * Network errors (fetch failure) have `statusCode = 0`.
 */
export class RegistrationError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "RegistrationError";
    this.statusCode = statusCode;
  }
}

/** Returns true for errors that are likely transient and worth retrying. */
function isTransientRegistrationError(error: unknown): boolean {
  if (error instanceof RegistrationError) {
    // 5xx = server errors (including Cloudflare 521/522/523/524)
    // 0 = network-level failure (DNS, TCP, TLS)
    return error.statusCode === 0 || error.statusCode >= 500;
  }
  // Non-RegistrationError from fetch (e.g. TypeError for DNS failure)
  return true;
}

/**
 * Register this device with the Letta Cloud environments endpoint.
 * Throws on any failure with an error message suitable for wrapping in caller-specific context.
 */
export async function registerWithCloud(
  opts: RegisterOptions,
): Promise<RegisterResult> {
  const registerUrl = `${opts.serverUrl}/v1/environments/register`;

  const response = await fetch(registerUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.apiKey}`,
      "X-Letta-Source": "letta-code",
    },
    body: JSON.stringify({
      deviceId: opts.deviceId,
      connectionName: opts.connectionName,
      metadata: {
        lettaCodeVersion: getVersion(),
        os: process.platform,
        nodeVersion: process.version,
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
    const text = await response.text().catch(() => "");
    if (text) {
      try {
        const parsed = JSON.parse(text) as { message?: string };
        if (parsed.message) {
          detail = parsed.message;
        } else {
          detail += `: ${text.slice(0, 200)}`;
        }
      } catch {
        detail += `: ${text.slice(0, 200)}`;
      }
    }
    throw new RegistrationError(detail, response.status);
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
  };
}

const REGISTER_INITIAL_DELAY_MS = 1_000;
const REGISTER_MAX_DELAY_MS = 30_000;
const REGISTER_MAX_DURATION_MS = 2 * 60 * 1_000; // 2 minutes

export interface RegisterRetryCallbacks {
  /** Called before each retry attempt. */
  onRetry?: (attempt: number, delayMs: number, error: Error) => void;
}

/**
 * Register with Cloud, retrying on transient errors (5xx, network failures)
 * with exponential backoff. Fails immediately on client errors (4xx).
 */
export async function registerWithCloudRetry(
  opts: RegisterOptions,
  callbacks?: RegisterRetryCallbacks,
): Promise<RegisterResult> {
  const startTime = Date.now();
  let attempt = 0;

  for (;;) {
    try {
      return await registerWithCloud(opts);
    } catch (error) {
      const elapsed = Date.now() - startTime;

      if (
        !isTransientRegistrationError(error) ||
        elapsed >= REGISTER_MAX_DURATION_MS
      ) {
        throw error;
      }

      attempt++;
      const delay = Math.min(
        REGISTER_INITIAL_DELAY_MS * 2 ** (attempt - 1),
        REGISTER_MAX_DELAY_MS,
      );

      if (error instanceof Error) {
        callbacks?.onRetry?.(attempt, delay, error);
      }

      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
}
