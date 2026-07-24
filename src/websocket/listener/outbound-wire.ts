/**
 * Transport-level outbound wire layer for the listener.
 *
 * Owns everything between "a protocol message is ready to leave" and the
 * socket: the bounded per-transport queue, backpressure policy, and wire perf
 * telemetry. Message-level concerns (envelope shape, event_seq semantics,
 * frame classification) stay in protocol-outbound.ts, which hands this module
 * pre-classified frames with a deferred `build()`.
 *
 * Design (borrowed from codex app-server, adapted to our topology — see
 * LET-10138): producers never interact with socket state; they enqueue into a
 * bounded queue drained by this module against `bufferedAmount` watermarks.
 * Codex disconnects a slow client on overflow, which works for N direct
 * clients; the listener has a single socket to the cloud relay, so overflow
 * degrades by frame class instead — snapshot ("status") frames coalesce
 * latest-wins, streaming text ("delta") frames drop oldest-first, and
 * turn-critical frames are never dropped. A socket stalled past the kill
 * threshold is terminated so the existing reconnect + sync-replay machinery
 * can restore a clean stream.
 *
 * Frames are serialized (and take their event_seq) inside `build()` at drain
 * time, so coalesced or dropped frames never consume sequence numbers and the
 * wire stream stays gap-free.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { debugWarn, isDebugEnabled } from "@/utils/debug";
import {
  getListenerTransportKind,
  isListenerTransportOpen,
  type ListenerTransport,
} from "./transport";

/**
 * How a frame degrades under backpressure.
 * - "critical": never dropped (tool returns, approvals, stop reasons,
 *   command responses). If only critical frames remain and the queue is
 *   still over capacity, the transport is considered stalled and killed.
 * - "status": snapshot semantics — a newer frame with the same coalesceKey
 *   fully supersedes a queued one (loop status, device status, queue state).
 * - "delta": streaming text chunks; oldest are dropped first under pressure.
 *   The client recovers full content on the next sync replay.
 */
export type OutboundFrameClass = "critical" | "status" | "delta";

export interface OutboundFrame {
  /** Message type label for logs/telemetry (not parsed). */
  typeLabel: string;
  frameClass: OutboundFrameClass;
  /** Required for "status" frames: queued frame with the same key is replaced. */
  coalesceKey?: string;
  /**
   * Serialize the frame. Runs at drain time, immediately before the socket
   * write. Return null to skip the frame (e.g. sequence numbering became
   * unavailable). Must be side-effect free until the frame is actually sent;
   * post-send effects belong in `onSent`.
   */
  build(): { payload: string; perfKey: string; onSent?: () => void } | null;
  /** Called if the socket write throws. */
  onSendError?(error: unknown): void;
}

/**
 * Queue and watermark limits.
 *
 * MAX_QUEUED_FRAMES follows codex's bounded-channel approach (they use 128
 * per connection); we allow more headroom because one relay socket carries
 * every conversation and status frames coalesce away. HIGH_WATERMARK pauses
 * draining while the socket's own buffer is congested; KILL_THRESHOLD treats
 * the socket as stalled — terminating it hands recovery to the reconnect +
 * sync-replay path, which restores state cleanly (codex's disconnect-slow-
 * client policy adapted to a single-pipe topology).
 */
export const OUTBOUND_QUEUE_LIMITS = {
  MAX_QUEUED_FRAMES: 512,
  HIGH_WATERMARK_BUFFERED_BYTES: 512 * 1024,
  KILL_THRESHOLD_BUFFERED_BYTES: 16 * 1024 * 1024,
  DRAIN_POLL_MS: 50,
} as const;

type OutboundQueueState = {
  frames: OutboundFrame[];
  pollTimer: ReturnType<typeof setTimeout> | null;
  draining: boolean;
  droppedByClass: { status: number; delta: number };
  killed: boolean;
};

const queueByTransport = new WeakMap<ListenerTransport, OutboundQueueState>();

function getQueueState(transport: ListenerTransport): OutboundQueueState {
  let state = queueByTransport.get(transport);
  if (!state) {
    state = {
      frames: [],
      pollTimer: null,
      draining: false,
      droppedByClass: { status: 0, delta: 0 },
      killed: false,
    };
    queueByTransport.set(transport, state);
  }
  return state;
}

function terminateStalledTransport(
  transport: ListenerTransport,
  state: OutboundQueueState,
  reason: string,
): void {
  state.killed = true;
  state.frames = [];
  if (state.pollTimer) {
    clearTimeout(state.pollTimer);
    state.pollTimer = null;
  }
  recordOutboundQueuePerf("queue:killed", 1);
  console.error(
    `[Listen Wire] Terminating stalled transport (${reason}); reconnect will resync`,
  );
  if (getListenerTransportKind(transport) === "websocket") {
    const ws = transport as { terminate?: () => void; close?: () => void };
    try {
      ws.terminate ? ws.terminate() : ws.close?.();
    } catch {
      // Socket already dead — reconnect logic owns it from here.
    }
  }
}

function dropOneFrameForCapacity(
  transport: ListenerTransport,
  state: OutboundQueueState,
): void {
  const dropOldestOfClass = (frameClass: OutboundFrameClass): boolean => {
    const index = state.frames.findIndex((f) => f.frameClass === frameClass);
    if (index === -1) return false;
    const [dropped] = state.frames.splice(index, 1);
    if (dropped && dropped.frameClass !== "critical") {
      state.droppedByClass[dropped.frameClass] += 1;
      recordOutboundQueuePerf(`queue:dropped:${dropped.frameClass}`, 1);
    }
    return true;
  };

  if (dropOldestOfClass("delta")) return;
  if (dropOldestOfClass("status")) return;
  // Only critical frames remain and the queue is over capacity: the consumer
  // is not making progress. Reconnect + sync replay recovers all state.
  terminateStalledTransport(transport, state, "queue full of critical frames");
}

/**
 * Enqueue a frame and drain as far as the socket allows. When the socket is
 * healthy this sends synchronously in the same tick (identical behavior to
 * the pre-queue direct send); the queue only forms under backpressure.
 */
export function enqueueOutboundFrame(
  transport: ListenerTransport,
  frame: OutboundFrame,
): void {
  const state = getQueueState(transport);
  if (state.killed) return;

  if (frame.frameClass === "status" && frame.coalesceKey) {
    const index = state.frames.findIndex(
      (f) => f.frameClass === "status" && f.coalesceKey === frame.coalesceKey,
    );
    if (index !== -1) {
      // Snapshot semantics: replace in place so queue position (and fairness
      // relative to other frames) is preserved.
      state.frames[index] = frame;
      drainOutboundQueue(transport, state);
      return;
    }
  }

  state.frames.push(frame);
  while (state.frames.length > OUTBOUND_QUEUE_LIMITS.MAX_QUEUED_FRAMES) {
    dropOneFrameForCapacity(transport, state);
    if (state.killed) return;
  }
  drainOutboundQueue(transport, state);
}

function scheduleDrainPoll(
  transport: ListenerTransport,
  state: OutboundQueueState,
): void {
  if (state.pollTimer) return;
  state.pollTimer = setTimeout(() => {
    state.pollTimer = null;
    drainOutboundQueue(transport, state);
  }, OUTBOUND_QUEUE_LIMITS.DRAIN_POLL_MS);
  (state.pollTimer as { unref?: () => void }).unref?.();
}

function drainOutboundQueue(
  transport: ListenerTransport,
  state: OutboundQueueState,
): void {
  if (state.draining || state.killed) return;
  state.draining = true;
  try {
    while (state.frames.length > 0) {
      if (!isListenerTransportOpen(transport)) {
        // Closed socket: drop the backlog; reconnect sync-replay restores state.
        state.frames = [];
        return;
      }
      const buffered = transport.bufferedAmount;
      if (buffered >= OUTBOUND_QUEUE_LIMITS.KILL_THRESHOLD_BUFFERED_BYTES) {
        terminateStalledTransport(transport, state, "socket buffer stalled");
        return;
      }
      if (buffered >= OUTBOUND_QUEUE_LIMITS.HIGH_WATERMARK_BUFFERED_BYTES) {
        scheduleDrainPoll(transport, state);
        return;
      }

      const frame = state.frames.shift();
      if (!frame) return;
      const buildStartedAt = PERF_ENABLED ? performance.now() : 0;
      let built: ReturnType<OutboundFrame["build"]>;
      try {
        built = frame.build();
      } catch (error) {
        frame.onSendError?.(error);
        continue;
      }
      if (!built) continue;
      const stringifyMs = PERF_ENABLED ? performance.now() - buildStartedAt : 0;
      const sendStartedAt = PERF_ENABLED ? performance.now() : 0;
      try {
        transport.send(built.payload);
      } catch (error) {
        frame.onSendError?.(error);
        continue;
      }
      if (PERF_ENABLED) {
        recordWirePerfSample(built.perfKey, {
          bytes: Buffer.byteLength(built.payload),
          stringifyMs,
          sendMs: performance.now() - sendStartedAt,
          bufferedBefore: buffered,
          bufferedAfter: transport.bufferedAmount,
        });
      }
      built.onSent?.();
    }

    const dropped = state.droppedByClass;
    if (dropped.delta > 0 || dropped.status > 0) {
      debugWarn(
        "listen-wire",
        `Outbound backpressure dropped frames before catching up (delta=${dropped.delta}, status=${dropped.status}); client resyncs on next replay`,
      );
      state.droppedByClass = { status: 0, delta: 0 };
    }
  } finally {
    state.draining = false;
  }
}

/** Test/diagnostic visibility into a transport's queue. */
export function getOutboundQueueStats(transport: ListenerTransport): {
  queuedFrames: number;
  droppedDelta: number;
  droppedStatus: number;
  killed: boolean;
} {
  const state = queueByTransport.get(transport);
  return {
    queuedFrames: state?.frames.length ?? 0,
    droppedDelta: state?.droppedByClass.delta ?? 0,
    droppedStatus: state?.droppedByClass.status ?? 0,
    killed: state?.killed ?? false,
  };
}

// ----- Wire perf telemetry (moved from protocol-outbound.ts) -----
// Aggregates per-message-type send metrics into 1s windows, flushed to stderr
// or LETTA_LISTENER_PERF_FILE when LETTA_LISTENER_PERF is enabled.

const PERF_FLUSH_INTERVAL_MS = 1_000;
const PERF_ENV_VALUES = new Set(["1", "true", "yes"]);
const PERF_ENABLED = PERF_ENV_VALUES.has(
  (process.env.LETTA_LISTENER_PERF ?? "").toLowerCase(),
);
const PERF_FILE = process.env.LETTA_LISTENER_PERF_FILE?.trim() || null;

type WirePerfBucket = {
  count: number;
  bytes: number;
  stringifyMs: number;
  sendMs: number;
  maxBufferedBefore: number;
  maxBufferedAfter: number;
};

const wirePerfBuckets = new Map<string, WirePerfBucket>();
let wirePerfFlushTimer: ReturnType<typeof setTimeout> | null = null;
let wirePerfWindowStartedAt = 0;
let wirePerfFileDirEnsured: string | null = null;
let wirePerfFileWarningEmitted = false;

function scheduleWirePerfFlush(): void {
  if (wirePerfFlushTimer) {
    return;
  }
  wirePerfFlushTimer = setTimeout(() => {
    wirePerfFlushTimer = null;
    flushWirePerfTelemetry();
  }, PERF_FLUSH_INTERVAL_MS);
  (wirePerfFlushTimer as { unref?: () => void }).unref?.();
}

function recordWirePerfSample(
  key: string,
  sample: {
    bytes: number;
    stringifyMs: number;
    sendMs: number;
    bufferedBefore: number;
    bufferedAfter: number;
  },
): void {
  if (wirePerfWindowStartedAt === 0) {
    wirePerfWindowStartedAt = Date.now();
  }
  const bucket = wirePerfBuckets.get(key) ?? {
    count: 0,
    bytes: 0,
    stringifyMs: 0,
    sendMs: 0,
    maxBufferedBefore: 0,
    maxBufferedAfter: 0,
  };
  bucket.count += 1;
  bucket.bytes += sample.bytes;
  bucket.stringifyMs += sample.stringifyMs;
  bucket.sendMs += sample.sendMs;
  bucket.maxBufferedBefore = Math.max(
    bucket.maxBufferedBefore,
    sample.bufferedBefore,
  );
  bucket.maxBufferedAfter = Math.max(
    bucket.maxBufferedAfter,
    sample.bufferedAfter,
  );
  wirePerfBuckets.set(key, bucket);
  scheduleWirePerfFlush();
}

/** Queue events (drops, kills) surface in the same perf windows as sends. */
function recordOutboundQueuePerf(key: string, count: number): void {
  if (!PERF_ENABLED) {
    if (isDebugEnabled()) {
      debugWarn("listen-wire", `outbound queue event: ${key} (+${count})`);
    }
    return;
  }
  recordWirePerfSample(key, {
    bytes: 0,
    stringifyMs: 0,
    sendMs: 0,
    bufferedBefore: 0,
    bufferedAfter: 0,
  });
}

function writeWirePerfFile(
  record: {
    ts: string;
    event: "protocol_emit";
    window_ms: number;
    totals: WirePerfBucket;
    buckets: Record<
      string,
      WirePerfBucket & {
        avg_bytes: number;
        avg_stringify_ms: number;
        avg_send_ms: number;
      }
    >;
  },
  fallbackLine: string,
): void {
  const filePath = PERF_FILE;
  if (!filePath) {
    console.error(fallbackLine);
    return;
  }

  try {
    const dir = dirname(filePath);
    if (wirePerfFileDirEnsured !== dir) {
      mkdirSync(dir, { recursive: true });
      wirePerfFileDirEnsured = dir;
    }
    appendFileSync(filePath, `${JSON.stringify(record)}\n`, {
      encoding: "utf8",
    });
  } catch (error) {
    if (!wirePerfFileWarningEmitted) {
      wirePerfFileWarningEmitted = true;
      console.error(
        `[Listen Perf] Failed to write LETTA_LISTENER_PERF_FILE=${filePath}`,
        error,
      );
    }
    console.error(fallbackLine);
  }
}

function flushWirePerfTelemetry(): void {
  if (wirePerfBuckets.size === 0) {
    wirePerfWindowStartedAt = 0;
    return;
  }
  const windowMs = Math.max(1, Date.now() - wirePerfWindowStartedAt);
  const totals: WirePerfBucket = {
    count: 0,
    bytes: 0,
    stringifyMs: 0,
    sendMs: 0,
    maxBufferedBefore: 0,
    maxBufferedAfter: 0,
  };
  const buckets: Record<
    string,
    WirePerfBucket & {
      avg_bytes: number;
      avg_stringify_ms: number;
      avg_send_ms: number;
    }
  > = {};
  const parts = [...wirePerfBuckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, bucket]) => {
      totals.count += bucket.count;
      totals.bytes += bucket.bytes;
      totals.stringifyMs += bucket.stringifyMs;
      totals.sendMs += bucket.sendMs;
      totals.maxBufferedBefore = Math.max(
        totals.maxBufferedBefore,
        bucket.maxBufferedBefore,
      );
      totals.maxBufferedAfter = Math.max(
        totals.maxBufferedAfter,
        bucket.maxBufferedAfter,
      );
      buckets[key] = {
        ...bucket,
        avg_bytes: bucket.count > 0 ? bucket.bytes / bucket.count : 0,
        avg_stringify_ms:
          bucket.count > 0 ? bucket.stringifyMs / bucket.count : 0,
        avg_send_ms: bucket.count > 0 ? bucket.sendMs / bucket.count : 0,
      };

      const stringifyMs = bucket.stringifyMs.toFixed(2);
      const sendMs = bucket.sendMs.toFixed(2);
      return `${key}{count=${bucket.count},bytes=${bucket.bytes},stringify_ms=${stringifyMs},send_ms=${sendMs},max_buffered_before=${bucket.maxBufferedBefore},max_buffered_after=${bucket.maxBufferedAfter}}`;
    });
  writeWirePerfFile(
    {
      ts: new Date().toISOString(),
      event: "protocol_emit",
      window_ms: windowMs,
      totals,
      buckets,
    },
    `[Listen Perf] protocol_emit window_ms=${windowMs} ${parts.join(" ")}`,
  );
  wirePerfBuckets.clear();
  wirePerfWindowStartedAt = 0;
}

export const __outboundWireTestUtils = {
  clearTransportQueue(transport: ListenerTransport): void {
    queueByTransport.delete(transport);
  },
};
