export const MAX_RETRY_DURATION_MS = 5 * 60 * 1000; // 5 minutes
export const INITIAL_RETRY_DELAY_MS = 1000; // 1 second
export const MAX_RETRY_DELAY_MS = 30000; // 30 seconds

// Listener heartbeat: app-level ping/pong over the cloud relay. Each `ping`
// refreshes the environment's lastHeartbeat (the relay marks an env offline
// after ~120s of silence) and the relay replies with a `pong`.
export const LISTENER_HEARTBEAT_INTERVAL_MS = 30000; // 30 seconds
// Dead-peer detection window. If no `pong` is observed within this window, the
// underlying TCP is treated as half-open (laptop sleep, network switch,
// NAT/idle timeout) — which never emits a `close` event — and the socket is
// force-terminated to trigger the reconnect path. Set to 3 missed heartbeats
// so a single transient drop does not kill an otherwise healthy connection,
// while still reconnecting before the relay's ~120s offline cutoff.
export const LISTENER_PONG_TIMEOUT_MS = 90000; // 3 missed heartbeats

/**
 * Returns true when the listener has not observed a relay `pong` within
 * `timeoutMs`, indicating a likely half-open socket that should be terminated
 * to trigger a reconnect. Returns false when no pong has been recorded yet
 * (`lastPongAt === null`) so a freshly-connected socket is never killed before
 * its first heartbeat round-trip completes.
 */
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

export const LLM_API_ERROR_MAX_RETRIES = 3;
export const EMPTY_RESPONSE_MAX_RETRIES = 2;
export const MAX_PRE_STREAM_RECOVERY = 2;
export const MAX_POST_STOP_APPROVAL_RECOVERY = 2;

// Provider fallback: Anthropic model ID -> Bedrock model ID.
// Mirrors the headless recovery path: after one failed retry against
// Anthropic, retry the same turn using the Bedrock equivalent. Do not map
// generic/latest aliases unless the Bedrock target is the same model family.
export const PROVIDER_FALLBACK_MAP: Record<string, string> = {
  // Opus 4.7 variants -> Bedrock Opus 4.7.
  "opus-4.7-low": "bedrock-opus-4.7",
  "opus-4.7-medium": "bedrock-opus-4.7",
  "opus-4.7-high": "bedrock-opus-4.7",
  "opus-4.7-xhigh": "bedrock-opus-4.7",
  "opus-4.7-max": "bedrock-opus-4.7",
  // Opus 4.6 variants -> Bedrock Opus 4.6.
  "opus-4.6-no-reasoning": "bedrock-opus-4.6",
  "opus-4.6-low": "bedrock-opus-4.6",
  "opus-4.6-medium": "bedrock-opus-4.6",
  "opus-4.6-high": "bedrock-opus-4.6",
  "opus-4.6-xhigh": "bedrock-opus-4.6",
  // Sonnet 5 variants -> Bedrock Sonnet 5; Sonnet 4.6 variants -> Bedrock Sonnet 4.6
  sonnet: "bedrock-sonnet-5",
  "sonnet-5-no-reasoning": "bedrock-sonnet-5",
  "sonnet-5-low": "bedrock-sonnet-5",
  "sonnet-5-medium": "bedrock-sonnet-5",
  "sonnet-5-xhigh": "bedrock-sonnet-5",
  "sonnet-4.6": "bedrock-sonnet-4.6",
  "sonnet-1m": "bedrock-sonnet-4.6",
  "sonnet-4.6-no-reasoning": "bedrock-sonnet-4.6",
  "sonnet-4.6-low": "bedrock-sonnet-4.6",
  "sonnet-4.6-medium": "bedrock-sonnet-4.6",
  "sonnet-4.6-xhigh": "bedrock-sonnet-4.6",
};

export const PROVIDER_FALLBACK_NOTICE =
  "Anthropic API error; falling back to Bedrock...";
