import { debugLog } from "@/utils/debug";
import type { ListenerTransport } from "./transport";
import type { ListenerRuntime, StartListenerOptions } from "./types";

/** Heartbeats prove transport liveness, not that startup has finished. */
export function startListenerStartupDeadline(
  runtime: ListenerRuntime,
  transport: ListenerTransport,
  opts: Pick<StartListenerOptions, "onLog">,
  enabled = true,
): () => void {
  const socket = runtime.socket;
  if (!enabled || !socket || socket !== transport) return () => {};
  const configured = Number(process.env.LETTA_LISTENER_STARTUP_DEADLINE_MS);
  const deadlineMs =
    Number.isFinite(configured) && configured > 0 ? configured : 60_000;
  const clear = (): void => {
    clearTimeout(timer);
    socket.off("close", clear);
  };
  const timer = setTimeout(() => {
    clear();
    if (runtime.socket !== socket || runtime.intentionallyClosed) return;
    const message = `Listener startup did not finish within ${deadlineMs}ms; reconnecting`;
    try {
      if (opts.onLog) opts.onLog(message);
      else debugLog("Listen", message);
    } finally {
      // terminate forces close even when the peer never completes a close handshake.
      // The normal control close handler tears down the stream and retries.
      socket.terminate();
    }
  }, deadlineMs);
  socket.once("close", clear);
  timer.unref();
  return clear;
}
