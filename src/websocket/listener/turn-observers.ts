import { runWithRuntimeContext } from "@/runtime-context";
import { debugWarn } from "@/utils/debug";
import type { IncomingMessage } from "./types";

export interface TurnLifecycleHooks {
  onStarted?: () => void;
  onFinished: () => void;
}

const hooksByOtid = new Map<string, TurnLifecycleHooks>();

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

export async function runObservedTurn(
  msg: IncomingMessage,
  run: () => Promise<void>,
): Promise<void> {
  notifyTurnStarted(msg);
  try {
    await runWithRuntimeContext({ gitAttribution: msg.gitAttribution }, run);
  } finally {
    notifyTurnFinished(msg);
  }
}

export function notifyTurnStarted(msg: IncomingMessage): void {
  for (const otid of otidsOf(msg)) {
    try {
      hooksByOtid.get(otid)?.onStarted?.();
    } catch (error) {
      debugWarn("Listen V2", "Turn observer onStarted failed", error);
    }
  }
}

export function notifyTurnFinished(msg: IncomingMessage): void {
  for (const otid of otidsOf(msg)) {
    try {
      hooksByOtid.get(otid)?.onFinished();
    } catch (error) {
      debugWarn("Listen V2", "Turn observer onFinished failed", error);
    }
  }
}
