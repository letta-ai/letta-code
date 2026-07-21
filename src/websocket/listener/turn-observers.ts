import type { IncomingMessage } from "./types";

/**
 * Turn lifecycle observers keyed by message OTID.
 *
 * In-process protocol consumers (e.g. the OpenAI-compat HTTP bridge) need to
 * know when the specific turn carrying THEIR message starts and finishes.
 * Closure identity cannot provide this: the queue pump drains queued turns
 * with whichever processQueuedTurn closure scheduled it, so a turn may be
 * processed by another caller's closure. The turn processor itself notifies
 * this registry for every turn, keyed by the OTIDs of the messages it
 * carries, making correlation independent of the dispatch path.
 */
export interface TurnLifecycleHooks {
  onStarted?: () => void;
  onFinished: () => void;
}

const hooksByOtid = new Map<string, TurnLifecycleHooks>();

/** Returns an unregister function. */
export function registerTurnObserver(
  otid: string,
  hooks: TurnLifecycleHooks,
): () => void {
  hooksByOtid.set(otid, hooks);
  return () => {
    if (hooksByOtid.get(otid) === hooks) {
      hooksByOtid.delete(otid);
    }
  };
}

function otidsOf(msg: IncomingMessage): string[] {
  const otids: string[] = [];
  for (const message of msg.messages) {
    const otid = (message as { otid?: string | null }).otid;
    if (typeof otid === "string" && otid) otids.push(otid);
  }
  return otids;
}

export function notifyTurnStarted(msg: IncomingMessage): void {
  for (const otid of otidsOf(msg)) {
    try {
      hooksByOtid.get(otid)?.onStarted?.();
    } catch (error) {
      console.error("[Listen V2] Turn observer onStarted failed", error);
    }
  }
}

export function notifyTurnFinished(msg: IncomingMessage): void {
  for (const otid of otidsOf(msg)) {
    try {
      hooksByOtid.get(otid)?.onFinished();
    } catch (error) {
      console.error("[Listen V2] Turn observer onFinished failed", error);
    }
  }
}
