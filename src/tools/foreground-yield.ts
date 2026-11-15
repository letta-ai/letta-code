import { getRuntimeContext } from "@/runtime-context";

/** Default wait before a long-running tool call is returned as a background task. */
export const DEFAULT_FOREGROUND_YIELD_MS = 10_000;
/** Bounds for a controller-supplied foreground yield. */
export const MIN_FOREGROUND_YIELD_MS = 1_000;
export const MAX_FOREGROUND_YIELD_MS = 30_000;

export function clampForegroundYieldMs(value: number): number {
  return Math.max(
    MIN_FOREGROUND_YIELD_MS,
    Math.min(value, MAX_FOREGROUND_YIELD_MS),
  );
}

/**
 * Foreground yield for the current turn: the runtime tool policy's value when
 * the controller set one for this conversation, otherwise the default.
 */
export function resolveForegroundYieldMs(): number {
  const value = getRuntimeContext()?.foregroundYieldMs;
  return typeof value === "number" && Number.isFinite(value)
    ? clampForegroundYieldMs(value)
    : DEFAULT_FOREGROUND_YIELD_MS;
}
