import { normalizeTurnStartCancelReason } from "@/mods/turn-start-cancel";
import type {
  ModEventName,
  ModTurnStartCancelResult,
  ModTurnStartEvent,
} from "@/mods/types";

export function isTurnStartInput(
  value: unknown,
): value is ModTurnStartEvent["input"] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "object" && item !== null)
  );
}

export function isTurnStartQueueItems(
  value: unknown,
): value is ModTurnStartEvent["queueItems"] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        (item as { kind?: unknown }).kind === "context" &&
        "content" in item &&
        (typeof item.content === "string" || Array.isArray(item.content)),
    )
  );
}

export function cloneTurnStartInput(
  input: ModTurnStartEvent["input"],
): ModTurnStartEvent["input"] {
  return input.map((item) => structuredClone(item));
}

export function isTurnStartResultWithInput(
  name: ModEventName,
  result: unknown,
): result is { input: ModTurnStartEvent["input"] } {
  return (
    name === "turn_start" &&
    typeof result === "object" &&
    result !== null &&
    isTurnStartInput((result as { input?: unknown }).input)
  );
}

export function isTurnStartResultWithQueueItems(
  name: ModEventName,
  result: unknown,
): result is { queueItems: ModTurnStartEvent["queueItems"] } {
  return (
    name === "turn_start" &&
    typeof result === "object" &&
    result !== null &&
    isTurnStartQueueItems((result as { queueItems?: unknown }).queueItems)
  );
}

export function isTurnStartResultWithCancel(
  name: ModEventName,
  result: unknown,
): result is { cancel: ModTurnStartCancelResult } {
  if (name !== "turn_start" || typeof result !== "object" || !result) {
    return false;
  }
  const cancel = (result as { cancel?: unknown }).cancel;
  return (
    typeof cancel === "object" &&
    cancel !== null &&
    normalizeTurnStartCancelReason((cancel as { reason?: unknown }).reason) !==
      null
  );
}
