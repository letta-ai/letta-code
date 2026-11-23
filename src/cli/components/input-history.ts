export const MAX_INPUT_HISTORY_ENTRIES = 500;

export function appendInputHistory(prev: string[], entry: string): string[] {
  const last = prev[prev.length - 1];
  if (last !== undefined && entry.trim() === last.trim()) return prev;
  const next = [...prev, entry];
  if (next.length <= MAX_INPUT_HISTORY_ENTRIES) return next;
  return next.slice(next.length - MAX_INPUT_HISTORY_ENTRIES);
}
