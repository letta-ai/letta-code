import { INITIAL_RETRY_DELAY_MS, MAX_RETRY_DURATION_MS } from "./constants";

function positiveEnvMs(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return process.env[name] !== undefined &&
    Number.isFinite(parsed) &&
    parsed > 0
    ? parsed
    : fallback;
}

/** Ordinary startup connect budget; overridable so tests can exhaust it. */
export function listenerRetryDurationMs(): number {
  return positiveEnvMs(
    "LETTA_LISTENER_RETRY_DURATION_MS",
    MAX_RETRY_DURATION_MS,
  );
}

export function listenerInitialRetryDelayMs(): number {
  return positiveEnvMs(
    "LETTA_LISTENER_INITIAL_RETRY_DELAY_MS",
    INITIAL_RETRY_DELAY_MS,
  );
}

export const MAX_RETRY_ATTEMPTS = Math.ceil(
  Math.log2(MAX_RETRY_DURATION_MS / INITIAL_RETRY_DELAY_MS),
);

export function resolveNextListenerRetry(params: {
  attempt: number;
  startTime: number;
  hasSuccessfulConnection: boolean;
  rolloutSkewRetry: boolean;
  now?: number;
}): { attempt: number; startTime: number } {
  if (params.hasSuccessfulConnection) {
    return { attempt: 0, startTime: params.now ?? Date.now() };
  }
  if (params.rolloutSkewRetry) {
    return {
      attempt: Math.min(params.attempt + 1, MAX_RETRY_ATTEMPTS),
      startTime: params.now ?? Date.now(),
    };
  }
  return { attempt: params.attempt + 1, startTime: params.startTime };
}
