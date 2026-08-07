export interface MessageChannelIdempotencyScope {
  execute(key: string | null, effect: () => Promise<string>): Promise<string>;
}

type LastSuccessfulAction = {
  key: string;
};

export class MessageChannelDuplicateActionError extends Error {
  constructor(state: "in-flight" | "completed") {
    const detail =
      state === "in-flight"
        ? "an identical text send is already in progress"
        : "the immediately previous MessageChannel call already sent this exact text to the same destination";
    super(
      `Duplicate MessageChannel action suppressed: ${detail}. The duplicate was not sent; continue the turn instead of retrying it.`,
    );
    this.name = "MessageChannelDuplicateActionError";
  }
}

function isErrorResult(result: string): boolean {
  return result.startsWith("Error:");
}

/**
 * Suppress only an adjacent repeat of the last successful action. Distinct
 * MessageChannel actions clear the remembered result. Suppressed duplicates
 * throw so the agent receives explicit feedback instead of a false success.
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
      if (pendingDuplicate) {
        throw new MessageChannelDuplicateActionError("in-flight");
      }
      if (lastSuccessful?.key === key) {
        throw new MessageChannelDuplicateActionError("completed");
      }

      const invocation = ++latestInvocation;
      // A different MessageChannel action makes a later repeat legitimate.
      lastSuccessful = null;
      const pending = Promise.resolve().then(effect);
      inFlight.set(key, pending);

      try {
        const result = await pending;
        if (invocation === latestInvocation && !isErrorResult(result)) {
          lastSuccessful = { key };
        }
        return result;
      } finally {
        if (inFlight.get(key) === pending) inFlight.delete(key);
      }
    },
  };
}
