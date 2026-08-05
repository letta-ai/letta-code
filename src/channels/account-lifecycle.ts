import type { ChannelAdapter } from "./types";

interface AccountLifecycleIdentity {
  key: string;
  channelId: string;
  accountId: string;
}

interface CurrentAccountLifecycle extends AccountLifecycleIdentity {
  generation: number;
  signal?: AbortSignal;
}

function abortError(
  signal: AbortSignal,
  channelId: string,
  accountId: string,
): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(`Starting ${channelId}/${accountId} was cancelled.`);
}

export class ChannelAccountLifecycle {
  private readonly generations = new Map<string, number>();
  private shuttingDown = false;

  constructor(
    private readonly unregisterAdapterIfCurrent: (
      key: string,
      adapter: ChannelAdapter,
    ) => void,
  ) {}

  begin(key: string): number {
    const generation = (this.generations.get(key) ?? 0) + 1;
    this.generations.set(key, generation);
    return generation;
  }

  assertCurrent(input: CurrentAccountLifecycle): void {
    if (input.signal?.aborted) {
      throw abortError(input.signal, input.channelId, input.accountId);
    }
    if (
      this.shuttingDown ||
      this.generations.get(input.key) !== input.generation
    ) {
      throw new Error(
        `Starting ${input.channelId}/${input.accountId} was superseded by a newer lifecycle operation.`,
      );
    }
  }

  async awaitStep<T>(
    promise: Promise<T>,
    signal: AbortSignal | undefined,
    identity: AccountLifecycleIdentity,
  ): Promise<T> {
    if (!signal) return promise;
    if (signal.aborted) {
      throw abortError(signal, identity.channelId, identity.accountId);
    }

    let abortHandler: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      abortHandler = () => {
        reject(abortError(signal, identity.channelId, identity.accountId));
      };
      signal.addEventListener("abort", abortHandler, { once: true });
    });
    try {
      return await Promise.race([promise, aborted]);
    } finally {
      if (abortHandler) {
        signal.removeEventListener("abort", abortHandler);
      }
    }
  }

  retire(
    key: string,
    adapter: ChannelAdapter,
    startPromise: Promise<void> | undefined,
  ): void {
    this.unregisterAdapterIfCurrent(key, adapter);
    const stopQuietly = async (): Promise<void> => {
      try {
        await adapter.stop();
      } catch {
        // Best-effort cleanup; a late start completion retries stop below.
      } finally {
        this.unregisterAdapterIfCurrent(key, adapter);
      }
    };

    void stopQuietly();
    if (startPromise) {
      void startPromise.then(stopQuietly, stopQuietly);
    }
  }

  shutdown(): void {
    this.shuttingDown = true;
  }
}
