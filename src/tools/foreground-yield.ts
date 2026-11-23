import { getRuntimeContext } from "@/runtime-context";

export const DEFAULT_FOREGROUND_YIELD_MS = 10_000;
export const MIN_FOREGROUND_YIELD_MS = 1_000;
export const MAX_FOREGROUND_YIELD_MS = 30_000;

export function clampForegroundYieldMs(value: number): number {
  return Math.max(
    MIN_FOREGROUND_YIELD_MS,
    Math.min(value, MAX_FOREGROUND_YIELD_MS),
  );
}

export function resolveForegroundYieldMs(): number {
  const value = getRuntimeContext()?.foregroundYieldMs;
  return typeof value === "number" && Number.isFinite(value)
    ? clampForegroundYieldMs(value)
    : DEFAULT_FOREGROUND_YIELD_MS;
}
