/**
 * Full-fidelity subagent events, kept on the computer that runs a subagent so
 * a parent on another computer can read each one once (`read_subagent_events`).
 *
 * Only caller-notified launches keep events here. Each event is stored once,
 * capped at {@link REMOTE_EVENT_MAX_BYTES} with an explicit truncation marker,
 * and the oldest are dropped past {@link REMOTE_EVENT_STORE_MAX_BYTES}.
 */

import type { SubagentEventRecord } from "@/types/subagent-protocol";

/** One entry of a task's event log (`<task>.jsonl`). */
export type TaskEventRecord = SubagentEventRecord;

/** Largest single event sent to a parent on another computer. */
export const REMOTE_EVENT_MAX_BYTES = 256 * 1024;
/** Most event bytes kept per subagent for a parent to read. */
export const REMOTE_EVENT_STORE_MAX_BYTES = 32 * 1024 * 1024;
/** Default and largest page size for one `read_subagent_events` reply. */
export const REMOTE_EVENT_PAGE_BYTES = 1024 * 1024;

const TRUNCATABLE_FIELDS = ["output", "text", "input"] as const;

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/** Cut `text` to at most `maxBytes` UTF-8 bytes. */
function cutToBytes(text: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) return text;
  let end = Math.min(text.length, maxBytes);
  while (end > 0 && byteLength(text.slice(0, end)) > maxBytes) {
    end = Math.floor(end * 0.9);
  }
  return text.slice(0, end);
}

/**
 * Shrink an event to at most `maxBytes` of JSON by truncating its largest
 * payload field (`output`, `text`, or `input`). The cut field ends with
 * `[truncated N bytes]` and the event gains `truncated_bytes: N`.
 */
export function capTaskEvent(
  event: TaskEventRecord,
  maxBytes = REMOTE_EVENT_MAX_BYTES,
): TaskEventRecord {
  const json = JSON.stringify(event);
  const size = byteLength(json);
  if (size <= maxBytes) return event;
  let field: (typeof TRUNCATABLE_FIELDS)[number] | undefined;
  let fieldText = "";
  for (const key of TRUNCATABLE_FIELDS) {
    const value = event[key];
    if (value === undefined) continue;
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (text && byteLength(text) > byteLength(fieldText)) {
      field = key;
      fieldText = text;
    }
  }
  if (!field) return { seq: event.seq, at: event.at, type: event.type };
  const fieldBytes = byteLength(fieldText);
  // Leave room for the marker and JSON escaping of the kept text.
  const keepBytes = Math.max(0, fieldBytes - (size - maxBytes) - 256);
  let kept = cutToBytes(fieldText, keepBytes);
  let capped: TaskEventRecord;
  for (;;) {
    const dropped = fieldBytes - byteLength(kept);
    capped = {
      ...event,
      [field]: `${kept}\n[truncated ${dropped} bytes]`,
      truncated_bytes: dropped,
    };
    if (byteLength(JSON.stringify(capped)) <= maxBytes || !kept) break;
    kept = cutToBytes(kept, Math.floor(byteLength(kept) * 0.9));
  }
  return capped;
}

interface StoredEvent {
  seq: number;
  event: TaskEventRecord;
  bytes: number;
}

interface EventStore {
  events: StoredEvent[];
  bytes: number;
  /** Highest seq dropped to stay under the store cap. */
  droppedThrough: number;
}

const stores = new Map<string, EventStore>();

/** Keep this subagent's events so a parent on another computer can read them. */
export function serveSubagentEvents(subagentId: string): void {
  if (!stores.has(subagentId)) {
    stores.set(subagentId, { events: [], bytes: 0, droppedThrough: 0 });
  }
}

export function isServingSubagentEvents(subagentId: string): boolean {
  return stores.has(subagentId);
}

/** Store an event for remote readers, if this subagent serves them. */
export function storeSubagentEvent(
  subagentId: string,
  event: TaskEventRecord,
): void {
  const store = stores.get(subagentId);
  if (!store) return;
  const capped = capTaskEvent(event);
  const bytes = byteLength(JSON.stringify(capped));
  store.events.push({ seq: capped.seq, event: capped, bytes });
  store.bytes += bytes;
  while (store.bytes > REMOTE_EVENT_STORE_MAX_BYTES && store.events.length) {
    const dropped = store.events.shift();
    if (!dropped) break;
    store.bytes -= dropped.bytes;
    store.droppedThrough = dropped.seq;
  }
}

export interface SubagentEventPage {
  events: TaskEventRecord[];
  /** Pass as `after_seq` to read the next page. */
  next_seq: number;
  has_more: boolean;
  /** Events after `after_seq` that are no longer kept. */
  missed: number;
}

/** Events after `afterSeq`, oldest first, up to about `maxBytes` of JSON. */
export function readSubagentEvents(
  subagentId: string,
  afterSeq: number,
  maxBytes = REMOTE_EVENT_PAGE_BYTES,
): SubagentEventPage | undefined {
  const store = stores.get(subagentId);
  if (!store) return undefined;
  const budget = Math.min(Math.max(1, maxBytes), REMOTE_EVENT_PAGE_BYTES);
  const missed = Math.max(0, store.droppedThrough - afterSeq);
  const events: TaskEventRecord[] = [];
  let bytes = 0;
  let next = Math.max(afterSeq, store.droppedThrough);
  let hasMore = false;
  for (const stored of store.events) {
    if (stored.seq <= afterSeq) continue;
    if (events.length > 0 && bytes + stored.bytes > budget) {
      hasMore = true;
      break;
    }
    events.push(stored.event);
    bytes += stored.bytes;
    next = stored.seq;
  }
  return { events, next_seq: next, has_more: hasMore, missed };
}

export function clearSubagentEvents(subagentId: string): void {
  stores.delete(subagentId);
}
