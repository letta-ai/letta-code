import { setTimeout as sleep } from "node:timers/promises";
import { telemetry } from "@/telemetry";

const CODEX_STEER_GRACE_MS = 10_000;

interface SteerDelivery<T> {
  queued: boolean;
  wait: (request: Promise<unknown>, receipt: T) => Promise<unknown>;
}

export function withCodexSteerReceipt<T>(
  operation: (delivery: SteerDelivery<T>) => Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const delivery: SteerDelivery<T> = {
      queued: false,
      async wait(request, receipt) {
        const timer = setTimeout(() => {
          delivery.queued = true;
          resolve(receipt);
        }, CODEX_STEER_GRACE_MS);
        try {
          return await request;
        } finally {
          clearTimeout(timer);
        }
      },
    };
    operation(delivery).then(resolve, (error: unknown) => {
      if (delivery.queued) {
        telemetry.trackError(
          "codex_queued_steer_failed",
          error instanceof Error ? error.message : String(error),
        );
      } else {
        reject(error);
      }
    });
  });
}

export async function withSessionLock<T>(
  session: { startLock: Promise<void> },
  operation: () => Promise<T>,
): Promise<T> {
  const previous = session.startLock;
  let release!: () => void;
  session.startLock = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

export async function waitForRejectedCodexSteer(
  session: { activeTurnId?: string },
  turnId: string,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  if (
    /no active turn to steer|expected[ _-]?turn[ _-]?id.*(?:does not match|mismatch)|turn[ _-]?id mismatch/i.test(
      message,
    )
  ) {
    const deadline = Date.now() + 3_000;
    while (session.activeTurnId === turnId && Date.now() < deadline) {
      await sleep(25);
    }
  }
  if (session.activeTurnId === turnId) throw error;
}
