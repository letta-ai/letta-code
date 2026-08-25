/**
 * Wall-clock timing for reasoning blocks.
 *
 * Time belongs to the thought block, keyed by the stable transcript line
 * id of its original (non-split) line. Backend messageIds may change
 * mid-stream (the accumulator updates line.messageId as chunks arrive),
 * so every seen messageId is registered as an alias to the block's span;
 * split lines share the messageId and resolve to the same span through
 * it. Nothing here persists across CLI restarts.
 */

import { useSyncExternalStore } from "react";

type ReasoningSpan = { startedAt: number; endedAt?: number };

const spans = new Map<string, ReasoningSpan>();
const aliases = new Map<string, string>();

/** First chunk of a block arrived; start its timer (idempotent). */
export function noteReasoningStart(blockId: string, messageId?: string): void {
  let span = spans.get(blockId);
  if (!span) {
    span = { startedAt: Date.now() };
    spans.set(blockId, span);
  }
  if (messageId) aliases.set(messageId, blockId);
}

/** Block was finalized; freeze its duration (idempotent). */
export function noteReasoningEnd(blockId: string): void {
  const span = spans.get(blockId);
  if (span && span.endedAt === undefined) {
    span.endedAt = Date.now();
  }
}

/** Span for a line's messageId or own id, or undefined when unknown. */
export function reasoningSpanOf(key?: string): ReasoningSpan | undefined {
  if (!key) return undefined;
  return spans.get(key) ?? spans.get(aliases.get(key) ?? "");
}

/**
 * Single shared one-second ticker for all visible elapsed timers.
 *
 * A module-level interval (not per-component useEffect intervals) so a
 * transcript repaint can never leave individual spoilers without a timer:
 * every mounted subscriber is woken by the same tick.
 */

let tickCount = 0;
const tickListeners = new Set<() => void>();
let tickerStarted = false;

function startTicker(): void {
  if (tickerStarted) return;
  tickerStarted = true;
  globalThis.setInterval(() => {
    tickCount += 1;
    for (const listener of tickListeners) listener();
  }, 1000);
}

function subscribeTick(listener: () => void): () => void {
  startTicker();
  tickListeners.add(listener);
  return () => {
    tickListeners.delete(listener);
  };
}

export function useReasoningTick(): number {
  return useSyncExternalStore(
    subscribeTick,
    () => tickCount,
    () => 0,
  );
}
