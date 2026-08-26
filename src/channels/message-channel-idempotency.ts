export interface MessageChannelIdempotencyState {
  successfulActionKeys: string[];
  successfulTextDeliveryKeys: string[];
  successfulRelayTextDeliveryKeys?: string[];
  lastSuccessfulActionKey: string | null;
}

export interface MessageChannelIdempotencyScope {
  execute(
    actionKey: string | null,
    textDeliveryKey: string | null,
    effect: () => Promise<string>,
  ): Promise<string>;
  executeRelay(
    actionKey: string | null,
    textDeliveryKey: string | null,
    effect: () => Promise<string>,
  ): Promise<string>;
  snapshot(): MessageChannelIdempotencyState | null;
}

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
 * Explicit calls suppress an adjacent repeat plus text already delivered by an
 * automatic relay. Relay suppression remembers every successful text delivery,
 * regardless of whether it used send or send-rich. In-flight state cannot be
 * serialized, so snapshot returns null until all dispatches settle.
 */
export function createMessageChannelIdempotencyScope(
  state?: MessageChannelIdempotencyState,
): MessageChannelIdempotencyScope {
  const inFlightActionKeys = new Map<string, Promise<string>>();
  const inFlightTextDeliveryKeys = new Map<string, number>();
  const inFlightRelayTextDeliveryKeys = new Set<string>();
  const successfulActionKeys = new Set(state?.successfulActionKeys ?? []);
  const successfulTextDeliveryKeys = new Set(
    state?.successfulTextDeliveryKeys ?? [],
  );
  const successfulRelayTextDeliveryKeys = new Set(
    state?.successfulRelayTextDeliveryKeys ?? [],
  );
  let lastSuccessfulActionKey = state?.lastSuccessfulActionKey ?? null;
  let latestInvocation = 0;

  const addInFlightTextDelivery = (key: string | null): void => {
    if (key) {
      inFlightTextDeliveryKeys.set(
        key,
        (inFlightTextDeliveryKeys.get(key) ?? 0) + 1,
      );
    }
  };
  const removeInFlightTextDelivery = (key: string | null): void => {
    if (!key) return;
    const remaining = (inFlightTextDeliveryKeys.get(key) ?? 1) - 1;
    if (remaining > 0) inFlightTextDeliveryKeys.set(key, remaining);
    else inFlightTextDeliveryKeys.delete(key);
  };

  return {
    async execute(actionKey, textDeliveryKey, effect) {
      if (!actionKey) {
        latestInvocation += 1;
        lastSuccessfulActionKey = null;
        return await effect();
      }

      if (
        inFlightActionKeys.has(actionKey) ||
        (textDeliveryKey && inFlightRelayTextDeliveryKeys.has(textDeliveryKey))
      ) {
        throw new MessageChannelDuplicateActionError("in-flight");
      }
      if (
        lastSuccessfulActionKey === actionKey ||
        (textDeliveryKey &&
          successfulRelayTextDeliveryKeys.has(textDeliveryKey))
      ) {
        throw new MessageChannelDuplicateActionError("completed");
      }

      const invocation = ++latestInvocation;
      lastSuccessfulActionKey = null;
      const pending = Promise.resolve().then(effect);
      inFlightActionKeys.set(actionKey, pending);
      addInFlightTextDelivery(textDeliveryKey);

      try {
        const result = await pending;
        if (!isErrorResult(result)) {
          successfulActionKeys.add(actionKey);
          if (textDeliveryKey) successfulTextDeliveryKeys.add(textDeliveryKey);
          if (invocation === latestInvocation) {
            lastSuccessfulActionKey = actionKey;
          }
        }
        return result;
      } finally {
        if (inFlightActionKeys.get(actionKey) === pending) {
          inFlightActionKeys.delete(actionKey);
        }
        removeInFlightTextDelivery(textDeliveryKey);
      }
    },
    async executeRelay(actionKey, textDeliveryKey, effect) {
      if (!actionKey) return await effect();
      if (
        inFlightActionKeys.has(actionKey) ||
        (textDeliveryKey && inFlightTextDeliveryKeys.has(textDeliveryKey))
      ) {
        throw new MessageChannelDuplicateActionError("in-flight");
      }
      if (
        successfulActionKeys.has(actionKey) ||
        (textDeliveryKey && successfulTextDeliveryKeys.has(textDeliveryKey))
      ) {
        throw new MessageChannelDuplicateActionError("completed");
      }
      const pending = Promise.resolve().then(effect);
      inFlightActionKeys.set(actionKey, pending);
      addInFlightTextDelivery(textDeliveryKey);
      if (textDeliveryKey) inFlightRelayTextDeliveryKeys.add(textDeliveryKey);
      try {
        const result = await pending;
        if (!isErrorResult(result)) {
          successfulActionKeys.add(actionKey);
          if (textDeliveryKey) {
            successfulTextDeliveryKeys.add(textDeliveryKey);
            successfulRelayTextDeliveryKeys.add(textDeliveryKey);
          }
        }
        return result;
      } finally {
        if (inFlightActionKeys.get(actionKey) === pending) {
          inFlightActionKeys.delete(actionKey);
        }
        removeInFlightTextDelivery(textDeliveryKey);
        if (textDeliveryKey)
          inFlightRelayTextDeliveryKeys.delete(textDeliveryKey);
      }
    },
    snapshot() {
      if (inFlightActionKeys.size > 0 || inFlightTextDeliveryKeys.size > 0) {
        return null;
      }
      return {
        successfulActionKeys: [...successfulActionKeys],
        successfulTextDeliveryKeys: [...successfulTextDeliveryKeys],
        successfulRelayTextDeliveryKeys: [...successfulRelayTextDeliveryKeys],
        lastSuccessfulActionKey,
      };
    },
  };
}
