export interface CancelledStreamIteration {
  cancelled: true;
  /** Settles only after the provider's in-flight iterator operation finishes. */
  settled: Promise<void>;
}

export function isCancelledStreamIteration<T>(
  iteration: IteratorResult<T> | CancelledStreamIteration,
): iteration is CancelledStreamIteration {
  return "cancelled" in iteration;
}

export async function nextUntilRunCancelled<T>(
  iterator: AsyncIterator<T>,
  signal: AbortSignal,
): Promise<IteratorResult<T> | CancelledStreamIteration> {
  if (signal.aborted) {
    return { cancelled: true, settled: Promise.resolve() };
  }

  return await new Promise((resolve, reject) => {
    let settleProvider!: () => void;
    const settled = new Promise<void>((settle) => {
      settleProvider = settle;
    });
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      resolve({ cancelled: true, settled });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const next = iterator.next();
      next.then(
        (result) => {
          settleProvider();
          signal.removeEventListener("abort", onAbort);
          resolve(result);
        },
        (error) => {
          settleProvider();
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    } catch (error) {
      settleProvider();
      signal.removeEventListener("abort", onAbort);
      reject(error);
    }
    // `iterator.next()` is arbitrary code and can synchronously trigger the
    // abort after the pre-check but before returning its pending promise.
    if (signal.aborted) onAbort();
  });
}

export async function settleProviderIterator<T>(
  iterator: AsyncIterator<T>,
  inFlightNext?: Promise<void>,
): Promise<void> {
  let returned: Promise<unknown> = Promise.resolve();
  if (iterator.return) {
    try {
      returned = Promise.resolve(iterator.return()).catch(() => undefined);
    } catch {
      returned = Promise.resolve();
    }
  }
  await Promise.all([inFlightNext ?? Promise.resolve(), returned]);
}
