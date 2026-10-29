import type { ModOwner, ModTurnStartCancelResult } from "@/mods/types";

/** Which loaded mod returned the turn_start cancel. Set by the host. */
export type ModTurnStartCancelSource = Pick<ModOwner, "path" | "scope">;

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

export function getTurnStartCancelSource(
  event: unknown,
): ModTurnStartCancelSource | null {
  if (!isRecord(event) || !isRecord(event.cancelSource)) return null;
  const { path, scope } = event.cancelSource;
  if (typeof path !== "string" || typeof scope !== "string") return null;
  return { path, scope: scope as ModTurnStartCancelSource["scope"] };
}

export interface ModTurnStartCancelRecord extends ModTurnStartCancelResult {
  source: ModTurnStartCancelSource;
}

/** Normalize a handler's cancel and record which loaded mod returned it. */
export function createTurnStartCancelRecord(
  result: { cancel: { reason?: unknown } },
  registration: { owner: ModTurnStartCancelSource },
): ModTurnStartCancelRecord | undefined {
  const reason = normalizeTurnStartCancelReason(result.cancel.reason);
  if (!reason) return undefined;
  const { path, scope } = registration.owner;
  return { reason, source: { path, scope } };
}

/** Write the winning cancel (or clear any stale one) onto the event. */
export function applyTurnStartCancel(
  event: object,
  record: ModTurnStartCancelRecord | undefined,
): void {
  const target = event as { cancel?: unknown; cancelSource?: unknown };
  if (record) {
    target.cancel = { reason: record.reason };
    target.cancelSource = { ...record.source };
  } else {
    delete target.cancel;
    delete target.cancelSource;
  }
}
