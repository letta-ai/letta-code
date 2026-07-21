import { ChannelIngressBuffer } from "./channel-reload";
import type { InboundChannelMessage } from "./types";

export class ChannelReloadIngress {
  private readonly buffer: ChannelIngressBuffer<InboundChannelMessage>;
  private flushing = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly processMessage: (
      message: InboundChannelMessage,
    ) => Promise<void>,
  ) {
    this.buffer = new ChannelIngressBuffer({
      isReady: () => true,
      deliver: (message) => this.enqueue(message),
    });
  }

  begin(): { finish: () => Promise<void>; bufferedCount: () => number } {
    const buffering = this.buffer.begin();
    return {
      bufferedCount: buffering.bufferedCount,
      finish: async () => {
        this.flushing = true;
        try {
          buffering.finish();
          while (true) {
            const draining = this.queue;
            await draining;
            if (draining === this.queue) break;
          }
        } finally {
          this.flushing = false;
        }
      },
    };
  }

  isActive(): boolean {
    return this.buffer.isBuffering() || this.flushing;
  }

  defer(message: InboundChannelMessage): boolean {
    if (this.buffer.isBuffering()) {
      this.buffer.deliverOrBuffer(message);
      return true;
    }
    if (this.flushing) {
      this.enqueue(message);
      return true;
    }
    return false;
  }

  reset(): void {
    this.buffer.reset();
    this.flushing = false;
  }

  private enqueue(message: InboundChannelMessage): void {
    const processing = this.queue.then(() => this.processMessage(message));
    this.queue = processing.catch((error) => {
      console.error(
        "[Channels] Failed to process buffered inbound message after reload:",
        error instanceof Error ? error.message : error,
      );
    });
  }
}
