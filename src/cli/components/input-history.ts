/**
 * Input history retention for the TUI composer.
 *
 * Submitted prompts are kept for up/down navigation. Without a cap the array
 * grows for the whole session (LET-13148), pinning every submitted prompt —
 * including large pasted ones — in memory for the process lifetime.
 */
export const MAX_INPUT_HISTORY_ENTRIES = 500;

/**
 * Append an entry to the input history, skipping duplicates of the most
 * recent entry (compared whitespace-insensitively) and keeping at most the
 * most recent MAX_INPUT_HISTORY_ENTRIES entries.
 */
export function appendInputHistory(prev: string[], entry: string): string[] {
  const last = prev[prev.length - 1];
  if (last !== undefined && entry.trim() === last.trim()) return prev;
  const next = [...prev, entry];
  if (next.length <= MAX_INPUT_HISTORY_ENTRIES) return next;
  return next.slice(next.length - MAX_INPUT_HISTORY_ENTRIES);
}
