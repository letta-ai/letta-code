import type { SubagentEventRecord } from "@/types/subagent-protocol";

export const REMOTE_EVENT_MAX_BYTES = 256 * 1024;
export const REMOTE_EVENT_STORE_MAX_BYTES = 32 * 1024 * 1024;
export const REMOTE_EVENT_PAGE_BYTES = 1024 * 1024;

const jsonBytes = (value: unknown) =>
  Buffer.byteLength(JSON.stringify(value), "utf8");

export function capTaskEvent(
  event: SubagentEventRecord,
  maxBytes = REMOTE_EVENT_MAX_BYTES,
): SubagentEventRecord {
  const size = jsonBytes(event);
  if (size <= maxBytes) return event;
  const field = ["output", "text", "input"].find((key) => key in event);
  if (!field) return { seq: event.seq, at: event.at, type: event.type };
  const value = event[field];
  const text = Buffer.from(
    typeof value === "string" ? value : (JSON.stringify(value) ?? ""),
  );
  const keep = Math.max(0, text.length - (size - maxBytes) - 128);
  const dropped = text.length - keep;
  return {
    ...event,
    [field]: `${text.subarray(0, keep).toString("utf8")}\n[truncated ${dropped} bytes]`,
    truncated_bytes: dropped,
  };
}

interface EventStore {
  events: Array<{ event: SubagentEventRecord; bytes: number }>;
  bytes: number;
  droppedThrough: number;
}

const stores = new Map<string, EventStore>();

export function serveSubagentEvents(subagentId: string): void {
  if (!stores.has(subagentId))
    stores.set(subagentId, { events: [], bytes: 0, droppedThrough: 0 });
}

export function storeSubagentEvent(
  subagentId: string,
  event: SubagentEventRecord,
): void {
  const store = stores.get(subagentId);
  if (!store) return;
  const capped = capTaskEvent(event);
  const bytes = jsonBytes(capped);
  store.events.push({ event: capped, bytes });
  store.bytes += bytes;
  while (store.bytes > REMOTE_EVENT_STORE_MAX_BYTES) {
    const dropped = store.events.shift();
    if (!dropped) break;
    store.bytes -= dropped.bytes;
    store.droppedThrough = dropped.event.seq;
  }
}

export function readSubagentEvents(
  subagentId: string,
  afterSeq: number,
  maxBytes = REMOTE_EVENT_PAGE_BYTES,
):
  | {
      events: SubagentEventRecord[];
      next_seq: number;
      has_more: boolean;
      missed: number;
    }
  | undefined {
  const store = stores.get(subagentId);
  if (!store) return undefined;
  const budget = Math.min(maxBytes, REMOTE_EVENT_PAGE_BYTES);
  const events: SubagentEventRecord[] = [];
  let bytes = 0;
  let next = Math.max(afterSeq, store.droppedThrough);
  let hasMore = false;
  for (const stored of store.events) {
    if (stored.event.seq <= afterSeq) continue;
    if (events.length > 0 && bytes + stored.bytes > budget) {
      hasMore = true;
      break;
    }
    events.push(stored.event);
    bytes += stored.bytes;
    next = stored.event.seq;
  }
  return {
    events,
    next_seq: next,
    has_more: hasMore,
    missed: Math.max(0, store.droppedThrough - afterSeq),
  };
}

export function clearSubagentEvents(subagentId: string): void {
  stores.delete(subagentId);
}
