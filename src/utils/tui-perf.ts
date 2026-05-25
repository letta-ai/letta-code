import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const TUI_PERF_FLUSH_INTERVAL_MS = 1_000;
const TUI_PERF_ENV_VALUES = new Set(["1", "true", "yes"]);
const TUI_PERF_ENABLED = TUI_PERF_ENV_VALUES.has(
  (process.env.LETTA_TUI_PERF ?? "").toLowerCase(),
);
const TUI_PERF_FILE = process.env.LETTA_TUI_PERF_FILE?.trim() || null;

type TuiPerfBucket = {
  count: number;
  bytes: number;
  ms: number;
  maxBytes: number;
  maxMs: number;
};

const tuiPerfBuckets = new Map<string, TuiPerfBucket>();
let tuiPerfFlushTimer: ReturnType<typeof setTimeout> | null = null;
let tuiPerfWindowStartedAt = 0;
let tuiPerfFileDirEnsured: string | null = null;
let tuiPerfWarningEmitted = false;
let tuiPerfExitHookRegistered = false;

function ensureExitHook(): void {
  if (tuiPerfExitHookRegistered) {
    return;
  }
  tuiPerfExitHookRegistered = true;
  process.once("beforeExit", () => {
    flushTuiPerfTelemetry();
  });
}

function scheduleTuiPerfFlush(): void {
  if (tuiPerfFlushTimer) {
    return;
  }
  tuiPerfFlushTimer = setTimeout(() => {
    tuiPerfFlushTimer = null;
    flushTuiPerfTelemetry();
  }, TUI_PERF_FLUSH_INTERVAL_MS);
  const timerWithUnref = tuiPerfFlushTimer as ReturnType<typeof setTimeout> & {
    unref?: () => void;
  };
  timerWithUnref.unref?.();
}

export function recordTuiPerf(
  key: string,
  sample?: {
    bytes?: number;
    ms?: number;
  },
): void {
  if (!TUI_PERF_ENABLED || !TUI_PERF_FILE) {
    return;
  }

  ensureExitHook();
  if (tuiPerfWindowStartedAt === 0) {
    tuiPerfWindowStartedAt = Date.now();
  }

  const bytes = sample?.bytes ?? 0;
  const ms = sample?.ms ?? 0;
  const bucket = tuiPerfBuckets.get(key) ?? {
    count: 0,
    bytes: 0,
    ms: 0,
    maxBytes: 0,
    maxMs: 0,
  };
  bucket.count += 1;
  bucket.bytes += bytes;
  bucket.ms += ms;
  bucket.maxBytes = Math.max(bucket.maxBytes, bytes);
  bucket.maxMs = Math.max(bucket.maxMs, ms);
  tuiPerfBuckets.set(key, bucket);
  scheduleTuiPerfFlush();
}

export function recordTuiJsonPayload(key: string, value: unknown): void {
  if (!TUI_PERF_ENABLED || !TUI_PERF_FILE) {
    return;
  }

  try {
    recordTuiPerf(key, { bytes: Buffer.byteLength(JSON.stringify(value)) });
  } catch {
    recordTuiPerf(key);
  }
}

function flushTuiPerfTelemetry(): void {
  if (tuiPerfBuckets.size === 0) {
    tuiPerfWindowStartedAt = 0;
    return;
  }

  const filePath = TUI_PERF_FILE;
  if (!filePath) {
    tuiPerfBuckets.clear();
    tuiPerfWindowStartedAt = 0;
    return;
  }

  const windowMs = Math.max(1, Date.now() - tuiPerfWindowStartedAt);
  const totals: TuiPerfBucket = {
    count: 0,
    bytes: 0,
    ms: 0,
    maxBytes: 0,
    maxMs: 0,
  };
  const buckets: Record<
    string,
    TuiPerfBucket & {
      avg_bytes: number;
      avg_ms: number;
    }
  > = {};

  for (const [key, bucket] of [...tuiPerfBuckets.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    totals.count += bucket.count;
    totals.bytes += bucket.bytes;
    totals.ms += bucket.ms;
    totals.maxBytes = Math.max(totals.maxBytes, bucket.maxBytes);
    totals.maxMs = Math.max(totals.maxMs, bucket.maxMs);
    buckets[key] = {
      ...bucket,
      avg_bytes: bucket.count > 0 ? bucket.bytes / bucket.count : 0,
      avg_ms: bucket.count > 0 ? bucket.ms / bucket.count : 0,
    };
  }

  try {
    const dir = dirname(filePath);
    if (tuiPerfFileDirEnsured !== dir) {
      mkdirSync(dir, { recursive: true });
      tuiPerfFileDirEnsured = dir;
    }
    appendFileSync(
      filePath,
      `${JSON.stringify({
        ts: new Date().toISOString(),
        event: "tui_activity",
        window_ms: windowMs,
        totals,
        buckets,
      })}\n`,
      { encoding: "utf8" },
    );
  } catch (error) {
    if (!tuiPerfWarningEmitted) {
      tuiPerfWarningEmitted = true;
      console.error(
        `[TUI Perf] Failed to write LETTA_TUI_PERF_FILE=${filePath}`,
        error,
      );
    }
  } finally {
    tuiPerfBuckets.clear();
    tuiPerfWindowStartedAt = 0;
  }
}
