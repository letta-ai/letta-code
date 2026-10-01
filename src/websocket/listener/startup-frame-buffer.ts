import type WebSocket from "ws";

export const MAX_PENDING_STARTUP_FRAMES = 256;
export const MAX_PENDING_STARTUP_FRAME_BYTES = 1024 * 1024;

function rawDataByteLength(data: WebSocket.RawData): number {
  if (Array.isArray(data)) {
    return data.reduce((total, chunk) => total + chunk.byteLength, 0);
  }
  return data.byteLength;
}

/** A bounded pre-initialization ingress queue. Overflow discards every payload. */
export class StartupFrameBuffer {
  #frames: WebSocket.RawData[] = [];
  #bytes = 0;
  #overflowed = false;

  constructor(private readonly onOverflow: () => void = () => {}) {}

  static forSockets(
    controlSocket: Pick<WebSocket, "terminate">,
    getStreamSocket: () => Pick<WebSocket, "terminate"> | null,
    report: (errorType: string, error: unknown, context: string) => void,
  ): StartupFrameBuffer {
    return new StartupFrameBuffer(() =>
      StartupFrameBuffer.terminateIngress(
        controlSocket,
        getStreamSocket(),
        report,
      ),
    );
  }

  push(data: WebSocket.RawData): boolean {
    if (this.#overflowed) return false;
    const bytes = rawDataByteLength(data);
    if (
      this.#frames.length >= MAX_PENDING_STARTUP_FRAMES ||
      bytes > MAX_PENDING_STARTUP_FRAME_BYTES - this.#bytes
    ) {
      this.clear();
      this.#overflowed = true;
      this.onOverflow();
      return false;
    }
    this.#frames.push(data);
    this.#bytes += bytes;
    return true;
  }

  drain(): WebSocket.RawData[] {
    if (this.#overflowed) return [];
    const frames = this.#frames;
    this.#frames = [];
    this.#bytes = 0;
    return frames;
  }

  clear(): void {
    this.#frames = [];
    this.#bytes = 0;
  }

  handle(
    data: WebSocket.RawData,
    ready: boolean,
    handleMessage: (frame: WebSocket.RawData) => Promise<void>,
  ): void {
    if (this.#overflowed) return;
    if (!ready) {
      this.push(data);
      return;
    }
    void handleMessage(data);
  }

  static terminateIngress(
    controlSocket: Pick<WebSocket, "terminate">,
    streamSocket: Pick<WebSocket, "terminate"> | null,
    report: (errorType: string, error: unknown, context: string) => void,
  ): void {
    report(
      "listener_startup_ingress_overflow",
      new Error("Listener startup ingress buffer exceeded its limit"),
      "listener_startup",
    );
    controlSocket.terminate();
    streamSocket?.terminate();
  }
}
