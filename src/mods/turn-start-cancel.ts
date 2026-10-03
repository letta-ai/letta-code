import type {
  ModOwner,
  ModTurnStartCancelResult,
  ModTurnStartCancelSource,
  ModTurnStartEvent,
} from "@/mods/types";

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

/** The loaded mod that produced the cancel, as recorded by the mod engine. */
export function getTurnStartCancelSource(
  event: unknown,
): ModTurnStartCancelSource | null {
  if (!isRecord(event) || !isRecord(event.cancelSource)) return null;
  const { path, scope } = event.cancelSource;
  if (typeof path !== "string" || typeof scope !== "string") return null;
  return { path, scope: scope as ModTurnStartCancelSource["scope"] };
}

export interface ModTurnStartCancelRecord {
  cancel: ModTurnStartCancelResult;
  source: ModTurnStartCancelSource;
}

export type ModTurnStartCancelEvent = ModTurnStartEvent & {
  cancel?: ModTurnStartCancelResult;
  cancelSource?: ModTurnStartCancelSource;
};

/** Record the first valid cancel and which loaded mod returned it. */
export function createTurnStartCancelRecord(
  result: { cancel: { reason?: unknown } },
  registration: { owner: Pick<ModOwner, "path" | "scope"> },
): ModTurnStartCancelRecord | undefined {
  const reason = normalizeTurnStartCancelReason(result.cancel.reason);
  if (!reason) return undefined;
  return {
    cancel: { reason },
    source: { path: registration.owner.path, scope: registration.owner.scope },
  };
}

export function applyTurnStartCancel(
  event: ModTurnStartCancelEvent,
  record: ModTurnStartCancelRecord | undefined,
): void {
  if (record) {
    event.cancel = { ...record.cancel };
    event.cancelSource = { ...record.source };
  } else {
    delete event.cancel;
    delete event.cancelSource;
  }
}
