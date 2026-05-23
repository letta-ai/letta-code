import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { LocalMessage } from "./local-message";

export type ProviderStreamPart = AssistantMessageEvent;

const LOCAL_MESSAGE = Symbol.for("@letta/local-provider-message");
const LOCAL_STATE_CHUNK_ONLY = Symbol.for("@letta/local-state-chunk-only");

export function attachLocalMessage<T extends object>(
  target: T,
  message: LocalMessage,
): T {
  Object.defineProperty(target, LOCAL_MESSAGE, {
    value: message,
    enumerable: false,
    configurable: false,
  });
  return target;
}

export function getAttachedLocalMessage(
  value: unknown,
): LocalMessage | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  return (value as Record<symbol, LocalMessage | undefined>)[LOCAL_MESSAGE];
}

export function markLocalStateChunkOnly<T extends object>(target: T): T {
  Object.defineProperty(target, LOCAL_STATE_CHUNK_ONLY, {
    value: true,
    enumerable: false,
    configurable: false,
  });
  return target;
}

export function isLocalStateChunkOnly(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<symbol, boolean | undefined>)[LOCAL_STATE_CHUNK_ONLY] ===
      true
  );
}
