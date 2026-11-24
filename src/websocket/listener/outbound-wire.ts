import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { debugWarn, isDebugEnabled } from "@/utils/debug";
import {
  getListenerTransportKind,
  isListenerTransportOpen,
  type ListenerTransport,
} from "./transport";

export type OutboundFrameClass = "critical" | "status";

export interface OutboundFrame {
  typeLabel: string;
  frameClass: OutboundFrameClass;
  coalesceKey?: string;
  build(): { payload: string; perfKey: string; onSent?: () => void } | null;
  onSendError?(error: unknown): void;
  onDropped?(): void;
}

export type OutboundFrameSettlement = "sent" | "dropped";
export interface OutboundFrameReceipt {
  settlement: Promise<OutboundFrameSettlement>;
  cancel(): void;
}

export const OUTBOUND_QUEUE_LIMITS = {
  MAX_QUEUED_FRAMES: 512,
  HIGH_WATERMARK_BUFFERED_BYTES: 512 * 1024,
  KILL_THRESHOLD_BUFFERED_BYTES: 16 * 1024 * 1024,
  DRAIN_POLL_MS: 50,
  MAX_BACKPRESSURE_MS: 5_000,
} as const;

type OutboundQueueState = {
  frames: OutboundFrame[];
  pollTimer: ReturnType<typeof setTimeout> | null;
  draining: boolean;
  killed: boolean;
  backpressureStartedAt: number | null;
};

const queueByTransport = new WeakMap<ListenerTransport, OutboundQueueState>();

function getQueueState(transport: ListenerTransport): OutboundQueueState {
  let state = queueByTransport.get(transport);
  if (!state) {
    state = {
      frames: [],
      pollTimer: null,
      draining: false,
      killed: false,
      backpressureStartedAt: null,
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
  for (const frame of state.frames.splice(0)) frame.onDropped?.();
  if (state.pollTimer) {
    clearTimeout(state.pollTimer);
    state.pollTimer = null;
  }
  recordOutboundQueuePerf("queue:killed", 1);
  debugWarn("Listen Wire", `Terminating stalled transport (${reason})`);
  if (getListenerTransportKind(transport) === "websocket") {
    const ws = transport as { terminate?: () => void; close?: () => void };
    try {
      ws.terminate ? ws.terminate() : ws.close?.();
    } catch {}
  }
}

export function enqueueOutboundFrame(
  transport: ListenerTransport,
  frame: OutboundFrame,
): OutboundFrameReceipt {
  let settled = false;
  let settle!: (result: OutboundFrameSettlement) => void;
  const settlement = new Promise<OutboundFrameSettlement>((resolve) => {
    settle = resolve;
  });
  const queuedFrame: OutboundFrame = {
    ...frame,
    onDropped: () => {
      frame.onDropped?.();
      if (!settled) {
        settled = true;
        settle("dropped");
      }
    },
    build: () => {
      const built = frame.build();
      if (!built) {
        queuedFrame.onDropped?.();
        return null;
      }
      return {
        ...built,
        onSent: () => {
          built.onSent?.();
          if (!settled) {
            settled = true;
            settle("sent");
          }
        },
      };
    },
  };
  const state = getQueueState(transport);
  if (state.killed) {
    queuedFrame.onDropped?.();
    return { settlement, cancel: () => undefined };
  }

  if (queuedFrame.frameClass === "status" && queuedFrame.coalesceKey) {
    const index = state.frames.findIndex(
      (f) =>
        f.frameClass === "status" && f.coalesceKey === queuedFrame.coalesceKey,
    );
    if (index !== -1) {
      state.frames.splice(index, 1)[0]?.onDropped?.();
    }
  }

  state.frames.push(queuedFrame);
  if (state.frames.length > OUTBOUND_QUEUE_LIMITS.MAX_QUEUED_FRAMES) {
    terminateStalledTransport(transport, state, "outbound queue full");
    return { settlement, cancel: () => undefined };
  }
  drainOutboundQueue(transport, state);
  return {
    settlement,
    cancel: () => {
      const index = state.frames.indexOf(queuedFrame);
      if (index !== -1) state.frames.splice(index, 1)[0]?.onDropped?.();
    },
  };
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
        for (const frame of state.frames.splice(0)) frame.onDropped?.();
        return;
      }
      const buffered = transport.bufferedAmount;
      if (buffered >= OUTBOUND_QUEUE_LIMITS.KILL_THRESHOLD_BUFFERED_BYTES) {
        terminateStalledTransport(transport, state, "socket buffer stalled");
        return;
      }
      if (buffered >= OUTBOUND_QUEUE_LIMITS.HIGH_WATERMARK_BUFFERED_BYTES) {
        const now = Date.now();
        state.backpressureStartedAt ??= now;
        if (
          now - state.backpressureStartedAt >=
          OUTBOUND_QUEUE_LIMITS.MAX_BACKPRESSURE_MS
        ) {
          terminateStalledTransport(
            transport,
            state,
            "socket buffer stayed above the high watermark",
          );
          return;
        }
        scheduleDrainPoll(transport, state);
        return;
      }
      state.backpressureStartedAt = null;

      const frame = state.frames.shift();
      if (!frame) return;
      const buildStartedAt = PERF_ENABLED ? performance.now() : 0;
      let built: ReturnType<OutboundFrame["build"]>;
      try {
        built = frame.build();
      } catch (error) {
        frame.onSendError?.(error);
        frame.onDropped?.();
        terminateStalledTransport(transport, state, "frame build failed");
        return;
      }
      if (!built) continue;
      const stringifyMs = PERF_ENABLED ? performance.now() - buildStartedAt : 0;
      const sendStartedAt = PERF_ENABLED ? performance.now() : 0;
      try {
        transport.send(built.payload);
      } catch (error) {
        frame.onSendError?.(error);
        frame.onDropped?.();
        terminateStalledTransport(transport, state, "socket write failed");
        return;
      }
      const bufferedAfter = transport.bufferedAmount;
      if (PERF_ENABLED) {
        recordWirePerfSample(built.perfKey, {
          bytes: Buffer.byteLength(built.payload),
          stringifyMs,
          sendMs: performance.now() - sendStartedAt,
          bufferedBefore: buffered,
          bufferedAfter,
        });
      }
      built.onSent?.();
      if (
        bufferedAfter >= OUTBOUND_QUEUE_LIMITS.KILL_THRESHOLD_BUFFERED_BYTES
      ) {
        terminateStalledTransport(
          transport,
          state,
          "socket buffer exceeded kill threshold",
        );
        return;
      }
      if (
        state.frames.length > 0 &&
        bufferedAfter >= OUTBOUND_QUEUE_LIMITS.HIGH_WATERMARK_BUFFERED_BYTES
      ) {
        state.backpressureStartedAt ??= Date.now();
        scheduleDrainPoll(transport, state);
        return;
      }
    }
    state.backpressureStartedAt = null;
  } finally {
    state.draining = false;
  }
}

export function getOutboundQueueStats(transport: ListenerTransport): {
  queuedFrames: number;
  killed: boolean;
} {
  const state = queueByTransport.get(transport);
  return {
    queuedFrames: state?.frames.length ?? 0,
    killed: state?.killed ?? false,
  };
}

export function closeOutboundTransportQueue(
  transport: ListenerTransport,
): void {
  const state = queueByTransport.get(transport);
  if (!state) return;
  if (state.pollTimer) {
    clearTimeout(state.pollTimer);
    state.pollTimer = null;
  }
  for (const frame of state.frames.splice(0)) frame.onDropped?.();
  if (!state.killed) queueByTransport.delete(transport);
}

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
