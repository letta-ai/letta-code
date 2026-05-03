import type { TextStreamPart, ToolSet } from "ai";
import type { LocalMessage } from "./LocalMessage";

export type ProviderStreamPart = TextStreamPart<ToolSet>;

const LOCAL_UI_MESSAGE = Symbol.for("@letta/local-ui-message");
const LOCAL_STATE_CHUNK_ONLY = Symbol.for("@letta/local-state-chunk-only");

export function attachLocalUIMessage<T extends object>(
  target: T,
  message: LocalMessage,
): T {
  Object.defineProperty(target, LOCAL_UI_MESSAGE, {
    value: message,
    enumerable: false,
    configurable: false,
  });
  return target;
}

export function getAttachedLocalUIMessage(
  value: unknown,
): LocalMessage | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  return (value as Record<symbol, LocalMessage | undefined>)[LOCAL_UI_MESSAGE];
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
