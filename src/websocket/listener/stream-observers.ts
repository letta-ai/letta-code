import { debugWarn } from "@/utils/debug";
import type { ListenerRuntime, ObservedProtocolV2Message } from "./types";

export function notifyStreamObservers(
  listener: ListenerRuntime | null,
  message: Record<string, unknown>,
  runtimeScope: ObservedProtocolV2Message["runtime"],
): void {
  if (!listener?.streamObservers?.size) return;
  const observed = {
    ...message,
    runtime: runtimeScope,
  } as ObservedProtocolV2Message;
  for (const observer of listener.streamObservers) {
    try {
      observer(observed);
    } catch (error) {
      debugWarn("Listen V2", "Stream observer failed", error);
    }
  }
}

export function notifyStreamObserversRuntimeStopped(
  listener: ListenerRuntime,
): void {
  if (!listener.streamObservers?.size) return;
  const observed = {
    type: "runtime_stopped",
    runtime: {},
  } as ObservedProtocolV2Message;
  for (const observer of [...listener.streamObservers]) {
    try {
      observer(observed);
    } catch (error) {
      debugWarn("Listen V2", "Stream observer failed on stop", error);
    }
  }
  listener.streamObservers.clear();
}
