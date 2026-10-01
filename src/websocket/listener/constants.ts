export const MAX_RETRY_DURATION_MS = 5 * 60 * 1000; // 5 minutes
export const INITIAL_RETRY_DELAY_MS = 1000; // 1 second
export const MAX_RETRY_DELAY_MS = 30000; // 30 seconds
// Split listener pairs are only usable once both control and stream sockets
// complete their opening handshake. If the stream upgrade makes no progress,
// tear down the incomplete pair and let the normal reconnect path build a
// coherent replacement instead of awaiting the stream socket forever.
export const LISTENER_STREAM_OPEN_TIMEOUT_MS = 30000; // 30 seconds

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

// Mid-stream resume policy for listener turns. When the socket carrying a
// run's stream dies (for example the cloud-api process that owned the run was
// killed during a rolling restart), the listener re-attaches to the run stream
// with `starting_after` the last seq_id. Without a policy the resume is one
// immediate attempt, which cannot succeed while cloud-api is still down. The
// policy must outlast a rolling restart (minutes), and once reconnected the
// server itself waits 90 s of producer-heartbeat silence before replay reports
// RUN_STREAM_PRODUCER_LOST, so the ceiling is sized in minutes: 0.5 + 1 + 2 +
// 4 s, then 56 attempts at 5 s = 287.5 s, about 5 minutes of waiting.
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
