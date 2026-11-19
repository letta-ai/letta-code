const DELIVERY_GRACE_MS = 10_000;

export interface QueuedDelivery<T> {
  queued: boolean;
  wait: <Result>(request: Promise<Result>, receipt: T) => Promise<Result>;
}

/** Return a queued receipt while the original operation continues. */
export function withQueuedDelivery<T>(
  operation: (delivery: QueuedDelivery<T>) => Promise<T>,
  onLateFailure: (error: unknown) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const delivery: QueuedDelivery<T> = {
      queued: false,
      async wait(request, receipt) {
        const timer = setTimeout(() => {
          delivery.queued = true;
          resolve(receipt);
        }, DELIVERY_GRACE_MS);
        try {
          return await request;
        } finally {
          clearTimeout(timer);
        }
      },
    };
    operation(delivery).then(resolve, (error: unknown) => {
      if (delivery.queued) {
        onLateFailure(error);
      } else {
        reject(error);
      }
    });
  });
}
