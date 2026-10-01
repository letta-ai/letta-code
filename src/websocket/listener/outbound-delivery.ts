import type { OutboundFrameSettlement } from "./outbound-wire";

export interface OutboundMessageDelivery {
  receipts: Array<{
    connectionId: string | null;
    settlement: Promise<OutboundFrameSettlement>;
    cancel(): void;
  }>;
  replayTo(connectionId: string): OutboundMessageDelivery;
}

export function createOutboundMessageDelivery(
  receipts: OutboundMessageDelivery["receipts"],
  replayTo: (connectionId: string) => OutboundMessageDelivery,
): OutboundMessageDelivery {
  return { receipts, replayTo };
}

type DeliveryWaitResult = "sent" | "interrupted";

function createInterruptWaiter(shouldInterrupt: () => boolean): {
  promise: Promise<"interrupted">;
  cancel(): void;
} {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let cancelled = false;
  const promise = new Promise<"interrupted">((resolve) => {
    const poll = () => {
      if (cancelled) return;
      if (shouldInterrupt()) {
        resolve("interrupted");
        return;
      }
      timer = setTimeout(poll, 50);
      (timer as { unref?: () => void }).unref?.();
    };
    poll();
  });
  return {
    promise,
    cancel: () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    },
  };
}

async function waitForOwner(
  getOwnerId: () => string | null,
  shouldInterrupt: () => boolean,
  timeoutMs?: number,
): Promise<string | null> {
  const startedAt = Date.now();
  while (!shouldInterrupt()) {
    const ownerId = getOwnerId();
    if (ownerId) return ownerId;
    if (timeoutMs !== undefined && Date.now() - startedAt >= timeoutMs) {
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

/** Deliver every terminal prefix to one current owner before advancing. */
export async function awaitOrderedOutboundDeliveries(params: {
  deliveries: OutboundMessageDelivery[];
  getOwnerId(): string | null;
  shouldInterrupt(): boolean;
  receiptMatchesOwner?(
    receipt: OutboundMessageDelivery["receipts"][number],
    ownerId: string,
  ): boolean;
  ownerWaitTimeoutMs?: number;
}): Promise<DeliveryWaitResult> {
  const { deliveries, getOwnerId, shouldInterrupt } = params;
  const receiptMatchesOwner =
    params.receiptMatchesOwner ??
    ((receipt, ownerId) => receipt.connectionId === ownerId);
  const deliveryAttempts = deliveries.map((delivery) => [delivery]);
  const unusableReceipts = new Set<
    OutboundMessageDelivery["receipts"][number]
  >();
  const sentOwners = deliveries.map(() => new Set<string>());
  const interruptDelivery = (): "interrupted" => {
    for (const attempts of deliveryAttempts) {
      for (const delivery of attempts) {
        for (const receipt of delivery.receipts) receipt.cancel();
      }
    }
    return "interrupted";
  };
  const settleForOwner = async (
    deliveryIndex: number,
    ownerId: string,
  ): Promise<"sent" | "dropped" | "interrupted"> => {
    if (sentOwners[deliveryIndex]?.has(ownerId)) return "sent";
    const attempts = deliveryAttempts[deliveryIndex];
    const initialDelivery = deliveries[deliveryIndex];
    if (!attempts || !initialDelivery) return "dropped";
    let receipt = attempts
      .flatMap((delivery) => delivery.receipts)
      .find(
        (candidate) =>
          receiptMatchesOwner(candidate, ownerId) &&
          !unusableReceipts.has(candidate),
      );
    if (!receipt) {
      const replay = initialDelivery.replayTo(ownerId);
      attempts.push(replay);
      receipt = replay.receipts.find((candidate) =>
        receiptMatchesOwner(candidate, ownerId),
      );
    }
    if (!receipt) return "dropped";
    const interruptWaiter = createInterruptWaiter(shouldInterrupt);
    let result: "sent" | "dropped" | "interrupted";
    try {
      result = await Promise.race([
        receipt.settlement,
        interruptWaiter.promise,
      ]);
    } finally {
      interruptWaiter.cancel();
    }
    if (result === "sent") {
      sentOwners[deliveryIndex]?.add(ownerId);
    } else if (result === "dropped") {
      unusableReceipts.add(receipt);
    }
    return result;
  };

  let terminalIndex = 0;
  deliveryLoop: while (terminalIndex < deliveries.length) {
    if (shouldInterrupt()) return interruptDelivery();
    const ownerId = await waitForOwner(
      getOwnerId,
      shouldInterrupt,
      params.ownerWaitTimeoutMs,
    );
    if (!ownerId) return interruptDelivery();
    for (let index = 0; index <= terminalIndex; index += 1) {
      const result = await settleForOwner(index, ownerId);
      if (result === "interrupted" || shouldInterrupt()) {
        return interruptDelivery();
      }
      if (result === "dropped" || getOwnerId() !== ownerId) {
        continue deliveryLoop;
      }
    }
    terminalIndex += 1;
  }
  return "sent";
}
