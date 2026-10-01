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
