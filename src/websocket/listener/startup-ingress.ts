import type WebSocket from "ws";
import type { StartupFrameBuffer } from "./startup-frame-buffer";

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

export function activateStartupIngress(
  buffer: StartupFrameBuffer,
  handleMessage: (data: WebSocket.RawData) => Promise<void>,
  isCurrentAndOpen: () => boolean,
): () => Promise<boolean> {
  return () => buffer.drainToLive(handleMessage, isCurrentAndOpen);
}
