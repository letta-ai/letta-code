/**
 * Wall-clock timing for reasoning blocks, keyed by backend messageId.
 *
 * Time belongs to the thought block, not to physical transcript lines: a
 * long block may be split into several lines by the token streaming
 * machinery (see trySplitContent in accumulator.ts), and every split keeps
 * the same messageId — so all parts of one block render the same elapsed
 * time without any field copying.
 */

type ReasoningSpan = { startedAt: number; endedAt?: number };

const spans = new Map<string, ReasoningSpan>();

/** First chunk of a block arrived; start its timer (idempotent). */
export function noteReasoningStart(messageId: string): void {
  if (!spans.has(messageId)) spans.set(messageId, { startedAt: Date.now() });
}

/** Block was finalized; freeze its duration (idempotent, optional-id safe). */
export function noteReasoningEnd(messageId?: string): void {
  if (!messageId) return;
  const span = spans.get(messageId);
  if (span && span.endedAt === undefined) span.endedAt = Date.now();
}

/** Span for a line's messageId, or undefined when unknown. */
export function reasoningSpanOf(messageId?: string): ReasoningSpan | undefined {
  return messageId ? spans.get(messageId) : undefined;
}
