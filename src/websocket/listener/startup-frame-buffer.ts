import type WebSocket from "ws";

export const MAX_PENDING_STARTUP_FRAMES = 256;
export const MAX_PENDING_STARTUP_FRAME_BYTES = 1024 * 1024;

export function rawDataByteLength(data: WebSocket.RawData): number {
  if (Array.isArray(data)) {
    return data.reduce((total, chunk) => total + chunk.byteLength, 0);
  }
  return data.byteLength;
}

/** A bounded pre-initialization ingress queue. Overflow discards every payload. */
export class StartupFrameBuffer {
  #frames: WebSocket.RawData[] = [];
  #bytes = 0;
  #phase: "buffering" | "draining" | "live" | "terminated" = "buffering";

  constructor(
    private readonly onOverflow: (
      capacity: "frame_count" | "byte_count",
    ) => void = () => {},
  ) {}

  static forSockets(
    controlSocket: Pick<WebSocket, "terminate">,
    getStreamSocket: () => Pick<WebSocket, "terminate"> | null,
    report: (errorType: string, error: unknown, context: string) => void,
    onOverflow?: (capacity: "frame_count" | "byte_count") => void,
  ): StartupFrameBuffer {
    return new StartupFrameBuffer((capacity) => {
      onOverflow?.(capacity);
      StartupFrameBuffer.terminateIngress(
        controlSocket,
        getStreamSocket(),
        report,
      );
    });
  }

  push(data: WebSocket.RawData): boolean {
    if (this.#phase === "terminated") return false;
    const bytes = rawDataByteLength(data);
    const capacity =
      this.#frames.length >= MAX_PENDING_STARTUP_FRAMES
        ? "frame_count"
        : bytes > MAX_PENDING_STARTUP_FRAME_BYTES - this.#bytes
          ? "byte_count"
          : null;
    if (capacity) {
      this.failOverflow(capacity);
      return false;
    }
    this.#frames.push(data);
    this.#bytes += bytes;
    return true;
  }

  drain(): WebSocket.RawData[] {
    if (this.#phase === "terminated") return [];
    const frames = this.#frames;
    this.#frames = [];
    this.#bytes = 0;
    return frames;
  }

  prepend(frames: WebSocket.RawData[]): boolean {
    if (this.#phase !== "buffering" || frames.length === 0) {
      return frames.length === 0;
    }
    const bytes = frames.reduce(
      (total, frame) => total + rawDataByteLength(frame),
      0,
    );
    const capacity =
      frames.length + this.#frames.length > MAX_PENDING_STARTUP_FRAMES
        ? "frame_count"
        : bytes > MAX_PENDING_STARTUP_FRAME_BYTES - this.#bytes
          ? "byte_count"
          : null;
    if (capacity) {
      this.failOverflow(capacity);
      return false;
    }
    this.#frames = [...frames, ...this.#frames];
    this.#bytes += bytes;
    return true;
  }

  takeRequestlessInputFrames(): WebSocket.RawData[] {
    if (this.#phase === "terminated") return [];
    const legacy: WebSocket.RawData[] = [];
    const retained: WebSocket.RawData[] = [];
    for (const frame of this.#frames) {
      try {
        const bytes = Array.isArray(frame)
          ? Buffer.concat(frame)
          : Buffer.from(frame as ArrayBuffer);
        const parsed = JSON.parse(bytes.toString("utf8")) as {
          type?: unknown;
          request_id?: unknown;
          payload?: { kind?: unknown };
        };
        const isRequestlessInput =
          parsed.type === "message" ||
          (parsed.type === "input" &&
            parsed.request_id === undefined &&
            parsed.payload?.kind === "create_message");
        (isRequestlessInput ? legacy : retained).push(frame);
      } catch {
        retained.push(frame);
      }
    }
    this.#frames = retained;
    this.#bytes = retained.reduce(
      (total, frame) => total + rawDataByteLength(frame),
      0,
    );
    return legacy;
  }

  clear(): void {
    this.#frames = [];
    this.#bytes = 0;
  }

  get frameCount(): number {
    return this.#frames.length;
  }

  get byteLength(): number {
    return this.#bytes;
  }

  get phase(): "buffering" | "draining" | "live" | "terminated" {
    return this.#phase;
  }

  abort(): void {
    if (this.#phase === "terminated") return;
    this.clear();
    this.#phase = "terminated";
  }

  /** Fail closed when startup ingress exceeds capacity. */
  failOverflow(capacity: "frame_count" | "byte_count" = "frame_count"): void {
    if (this.#phase === "terminated") return;
    // Record lineage poison before clearing the payload. Close handlers run after
    // socket termination and must not mistake the emptied buffer for healthy state.
    this.onOverflow(capacity);
    this.clear();
    this.#phase = "terminated";
  }

  accept(
    data: WebSocket.RawData,
    handleMessage: (frame: WebSocket.RawData) => Promise<void>,
  ): void {
    if (this.#phase === "terminated") return;
    if (this.#phase !== "live") {
      this.push(data);
      return;
    }
    void handleMessage(data);
  }

  async drainToLive(
    handleMessage: (frame: WebSocket.RawData) => Promise<void>,
    isCurrentAndOpen: () => boolean,
  ): Promise<boolean> {
    if (this.#phase === "terminated" || !isCurrentAndOpen()) {
      this.abort();
      return false;
    }
    this.#phase = "draining";
    while (this.#frames.length > 0) {
      const frame = this.#frames.shift();
      if (!frame) break;
      this.#bytes -= rawDataByteLength(frame);
      await handleMessage(frame);
      if (this.phase === "terminated" || !isCurrentAndOpen()) {
        this.abort();
        return false;
      }
    }
    if (!isCurrentAndOpen()) {
      this.abort();
      return false;
    }
    this.#phase = "live";
    return true;
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
    for (const socket of new Set(
      [controlSocket, streamSocket].filter(Boolean),
    )) {
      socket?.terminate();
    }
  }
}
