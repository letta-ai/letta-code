export interface ChannelStartupRetryPolicy {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_CHANNEL_STARTUP_RETRY_POLICY: ChannelStartupRetryPolicy = {
  maxAttempts: 5,
  initialDelayMs: 5000,
  maxDelayMs: 60000,
};

export interface ChannelStartupRetryTarget {
  channelId: string;
  accountId: string;
}

/**
 * Retry accounts that failed during channel startup with exponential backoff,
 * without disturbing accounts that already started. Returns a cancel function.
 */
export function scheduleChannelStartupRetries(options: {
  targets: ChannelStartupRetryTarget[];
  start: (target: ChannelStartupRetryTarget) => Promise<unknown>;
  shouldRetry: (target: ChannelStartupRetryTarget) => boolean;
  policy?: Partial<ChannelStartupRetryPolicy>;
  log?: (message: string) => void;
}): () => void {
  const policy = { ...DEFAULT_CHANNEL_STARTUP_RETRY_POLICY, ...options.policy };
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let cancelled = false;

  const schedule = (target: ChannelStartupRetryTarget, attempt: number) => {
    const label = `${target.channelId}/${target.accountId}`;
    if (attempt > policy.maxAttempts) {
      options.log?.(
        `giving up on ${label} after ${policy.maxAttempts} retry attempts`,
      );
      return;
    }
    const delayMs = Math.min(
      policy.initialDelayMs * 2 ** Math.min(attempt - 1, 30),
      policy.maxDelayMs,
    );
    options.log?.(
      `retrying ${label} in ${delayMs}ms (attempt ${attempt}/${policy.maxAttempts})`,
    );
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (cancelled || !options.shouldRetry(target)) return;
      void options.start(target).then(
        () => {
          if (!cancelled) options.log?.(`retry succeeded for ${label}`);
        },
        (error: unknown) => {
          if (cancelled) return;
          options.log?.(
            `retry ${attempt}/${policy.maxAttempts} failed for ${label}: ${error instanceof Error ? error.message : String(error)}`,
          );
          schedule(target, attempt + 1);
        },
      );
    }, delayMs);
    timer.unref?.();
    timers.add(timer);
  };

  for (const target of options.targets) schedule(target, 1);

  return () => {
    cancelled = true;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  };
}
