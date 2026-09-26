import { getInteractiveApprovalKind } from "@/tools/interactive-policy";
import type { ControlRequest } from "@/types/app-server-protocol";
import type { ChannelControlRequestEvent, ChannelTurnSource } from "./types";

type Handoff = {
  requestId: string;
  clear: (() => void) | null;
};

/** Keep cancellation ownership while approval delivery waits behind progress. */
export class ChannelControlHandoffs {
  private readonly pending = new Set<Handoff>();
  private readonly cancellations = new Set<{
    turn: object | null;
    handoffs: Set<Handoff>;
  }>();

  get size(): number {
    return this.pending.size;
  }

  enqueue(
    message: ControlRequest,
    source: ChannelTurnSource,
    turn: object,
    enqueue: (hook: () => Promise<void>) => Promise<void>,
    deliver: (event: ChannelControlRequestEvent) => void | Promise<void>,
  ): void {
    const handoff: Handoff = { requestId: message.request_id, clear: null };
    this.pending.add(handoff);
    for (const cancellation of this.cancellations) {
      if (cancellation.turn === turn) cancellation.handoffs.add(handoff);
    }
    void enqueue(async () => {
      try {
        if (!handoff.clear) {
          await deliver({
            requestId: message.request_id,
            kind:
              getInteractiveApprovalKind(message.request.tool_name) ??
              "generic_tool_approval",
            source,
            toolName: message.request.tool_name,
            input: message.request.input,
          });
        }
      } finally {
        // Cancellation can arrive while registration itself is yielding.
        this.pending.delete(handoff);
        handoff.clear?.();
      }
    }).catch(() => {});
  }

  async cancel(
    turn: object | null,
    cancel: () => Promise<boolean>,
    clear: (requestId: string) => void,
  ): Promise<boolean> {
    // ControlRequest has no wire turn ID. Use the gateway's active-turn identity,
    // which changes on activation, not on hook delivery or abort acknowledgment.
    // Retain delivered handoffs until the roundtrip settles as well as queued ones.
    const cancellation = { turn, handoffs: new Set(this.pending) };
    this.cancellations.add(cancellation);
    try {
      const cancelled = await cancel();
      if (cancelled) {
        for (const handoff of cancellation.handoffs) {
          handoff.clear = () => clear(handoff.requestId);
          handoff.clear();
        }
      }
      return cancelled;
    } finally {
      this.cancellations.delete(cancellation);
    }
  }
}
