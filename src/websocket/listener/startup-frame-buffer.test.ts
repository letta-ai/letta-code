import { describe, expect, mock, test } from "bun:test";
import {
  MAX_PENDING_STARTUP_FRAME_BYTES,
  MAX_PENDING_STARTUP_FRAMES,
  StartupFrameBuffer,
} from "./startup-frame-buffer";

describe("startup frame buffering", () => {
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
      buffer.handle(Buffer.from("frame"), false, async () => {});
    }
    buffer.handle(Buffer.from("later"), false, async () => {});

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

    buffer.handle(
      Buffer.alloc(MAX_PENDING_STARTUP_FRAME_BYTES + 1),
      false,
      async () => {},
    );

    expect(terminate).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledTimes(1);
    expect(buffer.drain()).toEqual([]);
  });
});
