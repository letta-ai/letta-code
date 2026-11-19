import { setTimeout as sleep } from "node:timers/promises";
import { telemetry } from "@/telemetry";
import { type QueuedDelivery, withQueuedDelivery } from "./queued-delivery";

export function withCodexSteerReceipt<T>(
  operation: (delivery: QueuedDelivery<T>) => Promise<T>,
): Promise<T> {
  return withQueuedDelivery(operation, (error) =>
    telemetry.trackError(
      "codex_queued_steer_failed",
      error instanceof Error ? error.message : String(error),
    ),
  );
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

/** Let the completion notification reach its original waiter before starting again. */
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
