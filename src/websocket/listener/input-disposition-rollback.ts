import {
  deleteCurrentEntry,
  durableTransaction,
  getLedger,
  syncMemoryFromDurable,
} from "./input-disposition";
import type { ConversationRuntime, InputDispositionReservation } from "./types";

export function rollbackInputDisposition(
  runtime: ConversationRuntime,
  reservation: InputDispositionReservation | undefined,
): boolean {
  if (!reservation) return true;
  const ledger = getLedger(runtime.listener);
  if (ledger.persistentPath) {
    try {
      durableTransaction(ledger.persistentPath, (store) => {
        const held = store.reservations[reservation.key];
        const matches =
          !!held &&
          held.token === reservation.token &&
          held.generation === reservation.generation &&
          held.runtimeKey === runtime.key;
        if (matches) delete store.reservations[reservation.key];
        syncMemoryFromDurable(ledger, store);
        return { result: undefined, changed: matches };
      });
      ledger.abandonedReservations.delete(reservation.key);
      return true;
    } catch {
      ledger.abandonedReservations.set(reservation.key, {
        generation: reservation.generation,
        token: reservation.token,
      });
      return false;
    }
  }
  const entry = ledger.entries.get(reservation.key);
  if (!entry || entry.disposition !== null) return true;
  deleteCurrentEntry(ledger, reservation.key, reservation.generation);
  return true;
}
