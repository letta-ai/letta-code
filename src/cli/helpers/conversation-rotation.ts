// Pure helpers for rotating ("tab cycling") through an agent's conversation
// threads. Kept dependency-free so the logic can be unit-tested in isolation
// from the TUI and backend.

export type ConversationRotationDirection = "next" | "prev";

/**
 * Given an ordered list of conversation ids and the id of the current thread,
 * return the id of the thread to switch to when rotating in `direction`.
 *
 * Conventions:
 * - "next" advances toward later indices (Ctrl+PageDown); "prev" moves toward
 *   earlier indices (Ctrl+PageUp). Both wrap around the ends.
 * - Duplicate ids are ignored so a thread that also appears pinned/elsewhere
 *   does not create a dead step.
 * - Returns `null` when there is nowhere to rotate to: an empty list, a list
 *   that only contains the current thread, or a current id that is absent from
 *   the list (callers should make sure the current id is included first).
 */
export function computeRotatedConversationId(
  orderedIds: string[],
  currentId: string,
  direction: ConversationRotationDirection,
): string | null {
  const ids: string[] = [];
  for (const id of orderedIds) {
    if (id && !ids.includes(id)) ids.push(id);
  }

  const index = ids.indexOf(currentId);
  if (index === -1 || ids.length <= 1) return null;

  const delta = direction === "next" ? 1 : -1;
  const nextIndex = (index + delta + ids.length) % ids.length;
  return ids[nextIndex] ?? null;
}

/**
 * Ensure the current thread participates in rotation even if it is missing from
 * the fetched page (e.g. an older thread beyond the first page, or the synthetic
 * "default" conversation). The current id is prepended when absent so it has a
 * stable position to rotate away from.
 */
export function withCurrentConversation(
  orderedIds: string[],
  currentId: string,
): string[] {
  if (!currentId) return orderedIds;
  return orderedIds.includes(currentId)
    ? orderedIds
    : [currentId, ...orderedIds];
}
