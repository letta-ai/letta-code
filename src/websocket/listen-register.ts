import { createHash } from "node:crypto";
import { getDesktopAccessToken } from "@/auth/desktop-credentials";
import { getSelfUpdateStatus } from "@/updater/auto-update";
import { getMachineMetadata } from "@/utils/machine-metadata";
import { getVersion } from "@/version.ts";
import { SUPPORTED_REMOTE_COMMANDS } from "./listener/listener-constants";

export interface RegisterResult {
  connectionId: string;
  wsUrl: string;
  supportsSplitStatusChannels: boolean;
  supportsPairedListenerGenerations: boolean;
}

export interface CredentialBootstrap {
  refreshToken: string;
  expiresIn: number;
}

export interface RegisterOptions {
  serverUrl: string;
  apiKey: string;
  deviceId: string;
  connectionName: string;
  listenerInstanceId?: string;
  onCredentialBootstrap?: (bootstrap: CredentialBootstrap) => Promise<void>;
}

export function deriveListenerInstanceId(
  surface: "server" | "listen",
  connectionName: string,
): string {
  const nameHash = createHash("sha256")
    .update(connectionName)
    .digest("hex")
    .slice(0, 16);
  return `${surface}-${nameHash}`;
}

type FetchImpl = typeof fetch;

export class RegistrationError extends Error {
  readonly statusCode: number;
  readonly retryAfterMs?: number;
  constructor(message: string, statusCode: number, retryAfterMs?: number) {
    super(message);
    this.name = "RegistrationError";
    this.statusCode = statusCode;
    this.retryAfterMs = retryAfterMs;
  }
}

function isTransientRegistrationError(error: unknown): boolean {
  if (error instanceof RegistrationError) {
    return (
      error.statusCode === 0 ||
      error.statusCode === 429 ||
      error.statusCode >= 500
    );
  }
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

export async function registerWithCloud(
  opts: RegisterOptions,
  fetchImpl: FetchImpl = fetch,
): Promise<RegisterResult> {
  const registerUrl = `${opts.serverUrl}/v1/environments/register`;

  const response = await fetchImpl(registerUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getDesktopAccessToken() ?? opts.apiKey}`,
      "X-Letta-Source": "letta-code",
    },
    body: JSON.stringify({
      deviceId: opts.deviceId,
      ...(opts.listenerInstanceId
        ? { listenerInstanceId: opts.listenerInstanceId }
        : {}),
      connectionName: opts.connectionName,
      metadata: {
        lettaCodeVersion: getVersion(),
        os: process.platform,
        nodeVersion: process.version,
        machine: await getMachineMetadata(),
        environmentMessageProtocol: "v2-input",
        supportsPairedListenerGenerations: true,
        supported_commands: SUPPORTED_REMOTE_COMMANDS,
        launch_subagent_notify_caller: true,
        subagent_message: true,
        subagent_message_retry_dedupe: true,
        external_fork_context: true,
        supportsComputerLinkCredentialBootstrap: opts.onCredentialBootstrap
          ? true
          : undefined,
        self_update: getSelfUpdateStatus(),
      },
    }),
  }).catch((fetchError: unknown) => {
    const msg =
      fetchError instanceof Error ? fetchError.message : String(fetchError);
    throw new RegistrationError(`Network error: ${msg}`, 0);
  });

  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    const retryAfterMs = parseRetryAfterMs(response.headers.get("Retry-After"));
    const text = await response.text().catch(() => "");
    if (text) {
      try {
        const parsed = JSON.parse(text) as {
          error?: string;
          errorCode?: string;
          message?: string;
        };
        if (parsed.message) {
          detail = parsed.message;
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
    throw new RegistrationError(detail, response.status, retryAfterMs);
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

  if (result.credentialBootstrap !== undefined) {
    const bootstrap = result.credentialBootstrap as Record<string, unknown>;
    if (
      !bootstrap ||
      typeof bootstrap !== "object" ||
      typeof bootstrap.refreshToken !== "string" ||
      typeof bootstrap.expiresIn !== "number"
    ) {
      throw new RegistrationError(
        "Server returned unexpected credential bootstrap shape",
        response.status,
      );
    }
    await opts.onCredentialBootstrap?.({
      refreshToken: bootstrap.refreshToken,
      expiresIn: bootstrap.expiresIn,
    });
  }

  return {
    connectionId: result.connectionId,
    wsUrl: result.wsUrl,
    supportsSplitStatusChannels: result.supportsSplitStatusChannels === true,
    supportsPairedListenerGenerations:
      result.supportsPairedListenerGenerations === true,
  };
}

const REGISTER_INITIAL_DELAY_MS = 1_000;
const REGISTER_MAX_DELAY_MS = 30_000;
const REGISTER_MAX_DURATION_MS = 2 * 60 * 1_000;
const REGISTER_MAX_JITTER_MS = 1_000;
const REGISTER_JITTER_RATIO = 0.25;

export interface RegisterRetryCallbacks {
  onRetry?: (attempt: number, delayMs: number, error: Error) => void;
  maxDurationMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
  fetchImpl?: FetchImpl;
  random?: () => number;
}

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
