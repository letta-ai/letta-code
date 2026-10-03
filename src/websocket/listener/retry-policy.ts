import { INITIAL_RETRY_DELAY_MS, MAX_RETRY_DURATION_MS } from "./constants";

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
