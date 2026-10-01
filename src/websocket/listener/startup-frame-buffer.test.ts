import { describe, expect, mock, test } from "bun:test";
import {
  MAX_PENDING_STARTUP_FRAME_BYTES,
  MAX_PENDING_STARTUP_FRAMES,
  StartupFrameBuffer,
} from "./startup-frame-buffer";

describe("startup frame buffering", () => {
  test("drains arrivals accepted during startup in strict FIFO order", async () => {
    const buffer = new StartupFrameBuffer();
    const handled: string[] = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const handle = async (frame: import("ws").RawData): Promise<void> => {
      handled.push(frame.toString());
      if (frame.toString() === "first") await firstBlocked;
    };
    buffer.accept(Buffer.from("first"), handle);
    buffer.accept(Buffer.from("second"), handle);
    const activation = buffer.drainToLive(handle, () => true);
    await Promise.resolve();
    buffer.accept(Buffer.from("third"), handle);
    expect(handled).toEqual(["first"]);
    expect(buffer.phase).toBe("draining");

    releaseFirst();
    await expect(activation).resolves.toBe(true);
    expect(handled).toEqual(["first", "second", "third"]);
    expect(buffer.phase).toBe("live");
  });

  test("does not apply startup limits after the pump is live", async () => {
    const terminate = mock(() => {});
    const buffer = StartupFrameBuffer.forSockets(
      { terminate },
      () => null,
      mock(() => {}),
    );
    const handled = mock(async () => {});
    await expect(buffer.drainToLive(handled, () => true)).resolves.toBe(true);
    for (let index = 0; index < MAX_PENDING_STARTUP_FRAMES * 2; index += 1) {
      buffer.accept(Buffer.alloc(8_192), handled);
    }
    expect(buffer.phase).toBe("live");
    expect(terminate).not.toHaveBeenCalled();
    expect(handled).toHaveBeenCalledTimes(MAX_PENDING_STARTUP_FRAMES * 2);
  });

  test("terminates the dynamically attached stream exactly once", () => {
    const controlTerminate = mock(() => {});
    const streamTerminate = mock(() => {});
    const report = mock(() => {});
    let streamSocket: { terminate: () => void } | null = null;
    const buffer = StartupFrameBuffer.forSockets(
      { terminate: controlTerminate },
      () => streamSocket,
      report,
    );
    streamSocket = { terminate: streamTerminate };

    for (let index = 0; index <= MAX_PENDING_STARTUP_FRAMES; index += 1) {
      buffer.accept(Buffer.from("frame"), async () => {});
    }
    buffer.accept(Buffer.from("later"), async () => {});

    expect(controlTerminate).toHaveBeenCalledTimes(1);
    expect(streamTerminate).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledTimes(1);
    expect(buffer.drain()).toEqual([]);
  });

  test("terminates when one frame exceeds the byte limit", () => {
    const terminate = mock(() => {});
    const report = mock(() => {});
    const buffer = StartupFrameBuffer.forSockets(
      { terminate },
      () => null,
      report,
    );

    buffer.accept(
      Buffer.alloc(MAX_PENDING_STARTUP_FRAME_BYTES + 1),
      async () => {},
    );

    expect(terminate).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledTimes(1);
    expect(buffer.drain()).toEqual([]);
  });
});
