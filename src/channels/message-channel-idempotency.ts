export interface MessageChannelIdempotencyScope {
  execute(key: string | null, effect: () => Promise<string>): Promise<string>;
}

type LastSuccessfulAction = {
  key: string;
  result: string;
};

function isErrorResult(result: string): boolean {
  return result.startsWith("Error:");
}

/**
 * Suppress only an adjacent repeat of the last successful action. Distinct
 * MessageChannel actions clear the remembered result, while identical actions
 * already in flight still share one external side effect.
 */
export function createMessageChannelIdempotencyScope(): MessageChannelIdempotencyScope {
  const inFlight = new Map<string, Promise<string>>();
  let lastSuccessful: LastSuccessfulAction | null = null;
  let latestInvocation = 0;

  return {
    async execute(key, effect) {
      if (!key) {
        latestInvocation += 1;
        lastSuccessful = null;
        return await effect();
      }

      const pendingDuplicate = inFlight.get(key);
      if (pendingDuplicate) return pendingDuplicate;
      if (lastSuccessful?.key === key) return lastSuccessful.result;

      const invocation = ++latestInvocation;
      // A different MessageChannel action makes a later repeat legitimate.
      lastSuccessful = null;
      const pending = Promise.resolve().then(effect);
      inFlight.set(key, pending);

      try {
        const result = await pending;
        if (invocation === latestInvocation && !isErrorResult(result)) {
          lastSuccessful = { key, result };
        }
        return result;
      } finally {
        if (inFlight.get(key) === pending) inFlight.delete(key);
      }
    },
  };
}
