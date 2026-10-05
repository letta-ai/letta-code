import type WebSocket from "ws";
import {
  MAX_PENDING_STARTUP_FRAME_BYTES,
  MAX_PENDING_STARTUP_FRAMES,
  rawDataByteLength,
  type StartupFrameBuffer,
} from "./startup-frame-buffer";
import type { ListenerConnectionState, ListenerRuntime } from "./types";

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

export function handoffRequestlessStartupFrames(
  runtime: ListenerRuntime,
  connection: ListenerConnectionState,
  buffer: StartupFrameBuffer,
): void {
  if (
    !connection.startupHandoffEnabled ||
    runtime.startupGenerationByLineage.get(connection.startupLineageId) !==
      connection.startupGeneration
  ) {
    return;
  }
  const frames = buffer.takeRequestlessInputFrames();
  if (frames.length === 0) return;
  const prior =
    runtime.pendingStartupFramesByLineage.get(connection.startupLineageId) ??
    [];
  const combined = [...prior, ...frames];
  const bytes = combined.reduce(
    (total, frame) => total + rawDataByteLength(frame),
    0,
  );
  // Match ordinary startup ingress bounds. Repeated replacement overflow fails
  // closed for this lineage without affecting concurrent connections.
  runtime.pendingStartupFramesByLineage.set(
    connection.startupLineageId,
    combined.length <= MAX_PENDING_STARTUP_FRAMES &&
      bytes <= MAX_PENDING_STARTUP_FRAME_BYTES
      ? combined
      : [],
  );
}

export function takeRequestlessStartupFrameHandoff(
  runtime: ListenerRuntime,
  connection: ListenerConnectionState,
): WebSocket.RawData[] {
  if (
    !connection.startupHandoffEnabled ||
    runtime.startupGenerationByLineage.get(connection.startupLineageId) !==
      connection.startupGeneration
  ) {
    return [];
  }
  const frames =
    runtime.pendingStartupFramesByLineage.get(connection.startupLineageId) ??
    [];
  runtime.pendingStartupFramesByLineage.delete(connection.startupLineageId);
  return frames;
}

export function activateStartupIngress(
  buffer: StartupFrameBuffer,
  handleMessage: (data: WebSocket.RawData) => Promise<void>,
  isCurrentAndOpen: () => boolean,
  takeHandoff?: () => WebSocket.RawData[],
): () => Promise<boolean> {
  return () => {
    const handoff = takeHandoff?.() ?? [];
    if (!buffer.prepend(handoff)) return Promise.resolve(false);
    return buffer.drainToLive(handleMessage, isCurrentAndOpen);
  };
}
