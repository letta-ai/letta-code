import type { ModTurnStartCancelResult } from "@/mods/types";

const MAX_TURN_START_CANCEL_REASON_LENGTH = 2000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function normalizeTurnStartCancelReason(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > MAX_TURN_START_CANCEL_REASON_LENGTH
    ? trimmed.slice(0, MAX_TURN_START_CANCEL_REASON_LENGTH)
    : trimmed;
}

export function getTurnStartCancel(
  event: unknown,
): ModTurnStartCancelResult | null {
  if (!isRecord(event) || !isRecord(event.cancel)) return null;
  const reason = normalizeTurnStartCancelReason(event.cancel.reason);
  return reason ? { reason } : null;
}
