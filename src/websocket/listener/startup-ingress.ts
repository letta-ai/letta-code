import type WebSocket from "ws";
import {
  MAX_PENDING_STARTUP_FRAME_BYTES,
  MAX_PENDING_STARTUP_FRAMES,
  rawDataByteLength,
  type StartupFrameBuffer,
} from "./startup-frame-buffer";
import type { ListenerRuntime } from "./types";

export function createReportedIngressHandler(
  handleMessage: (data: WebSocket.RawData) => Promise<void>,
  report: (errorType: string, error: unknown, context: string) => void,
  onError: (error: Error) => void,
): (data: WebSocket.RawData) => Promise<void> {
  return async (data) => {
    try {
      await handleMessage(data);
    } catch (error) {
      report(
        "listener_message_handler_failed",
        error,
        "listener_message_handler",
      );
      onError(error instanceof Error ? error : new Error(String(error)));
    }
  };
}

export async function waitForStartupOrAbort(
  startup: Promise<void> | undefined,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return;
  let onAbort!: () => void;
  const aborted = new Promise<void>((resolve) => {
    onAbort = () => resolve();
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([startup, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export function handoffLegacyStartupFrames(
  runtime: ListenerRuntime,
  buffer: StartupFrameBuffer,
): void {
  const frames = buffer.takeLegacyMessageFrames();
  if (frames.length === 0) return;
  const combined = [...(runtime.pendingLegacyStartupFrames ?? []), ...frames];
  const bytes = combined.reduce(
    (total, frame) => total + rawDataByteLength(frame),
    0,
  );
  // Match the ordinary startup ingress bounds. If repeated replacement exceeds
  // them, fail closed rather than retaining an unbounded process-level queue.
  runtime.pendingLegacyStartupFrames =
    combined.length <= MAX_PENDING_STARTUP_FRAMES &&
    bytes <= MAX_PENDING_STARTUP_FRAME_BYTES
      ? combined
      : [];
}

export function activateStartupIngress(
  buffer: StartupFrameBuffer,
  handleMessage: (data: WebSocket.RawData) => Promise<void>,
  isCurrentAndOpen: () => boolean,
  takeLegacyHandoff?: () => WebSocket.RawData[],
): () => Promise<boolean> {
  return () => {
    const handoff = takeLegacyHandoff?.() ?? [];
    if (!buffer.prepend(handoff)) return Promise.resolve(false);
    return buffer.drainToLive(handleMessage, isCurrentAndOpen);
  };
}
