export const CLOUD_ENVIRONMENT_NOT_FOUND_CLOSE_REASON = "Environment not found";

export const MAX_RETRY_DURATION_MS = 5 * 60 * 1000;
export const INITIAL_RETRY_DELAY_MS = 1000;
export const MAX_RETRY_DELAY_MS = 30000;
export const MAX_RETRY_ATTEMPTS = Math.ceil(
  Math.log2(MAX_RETRY_DURATION_MS / INITIAL_RETRY_DELAY_MS),
);
export const LISTENER_STREAM_OPEN_TIMEOUT_MS = 30000;

export const LISTENER_HANDSHAKE_TIMEOUT_MS = 30000;

export function getListenerSocketOptions(apiKey: string): {
  headers: Record<string, string>;
  handshakeTimeout: number;
} {
  const configured = Number(process.env.LETTA_LISTENER_HANDSHAKE_TIMEOUT_MS);
  return {
    headers: { Authorization: `Bearer ${apiKey}` },
    handshakeTimeout:
      Number.isFinite(configured) && configured > 0
        ? configured
        : LISTENER_HANDSHAKE_TIMEOUT_MS,
  };
}

export const LISTENER_HEARTBEAT_INTERVAL_MS = 30000;
export const LISTENER_PONG_TIMEOUT_MS = 90000;

export function isListenerPongStale(
  lastPongAt: number | null,
  now: number,
  timeoutMs: number,
): boolean {
  if (lastPongAt === null) {
    return false;
  }
  return now - lastPongAt > timeoutMs;
}

export const SYSTEM_REMINDER_RE =
  /<system-reminder>[\s\S]*?<\/system-reminder>/g;

export const LISTENER_STREAM_RESUME_POLICY = {
  initialDelayMs: 500,
  maxAttempts: 60,
  maxDelayMs: 5_000,
};

export const LLM_API_ERROR_MAX_RETRIES = 3;
export const CLOUD_API_DEPLOYMENT_RECOVERY_MAX_ATTEMPTS = 3;
export const EMPTY_RESPONSE_MAX_RETRIES = 2;
export const MAX_PRE_STREAM_RECOVERY = 2;
export const MAX_POST_STOP_APPROVAL_RECOVERY = 2;
