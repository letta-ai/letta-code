/**
 * Periodic safety net for wedged ConversationRuntime state.
 *
 * The liveness hard timer and queue watchdog should catch most stuck
 * runtimes, but neither guarantees the runtime state gets cleared when
 * a turn fails silently mid-flight (e.g. background cron/MCP work
 * throwing without a clean abort). This watchdog is the last resort:
 * scan conversationRuntimes at a configurable interval, detect
 * runtimes where isProcessing has been true for longer than
 * LETTA_RUNTIME_WATCHDOG_TIMEOUT_MS, and force-clear their state so
 * new cron fires (and inbound messages) are not blocked behind a
 * stuck queue.
 *
 * Off by default. Enable with LETTA_RUNTIME_WATCHDOG_ENABLED=1.
 */

import type {
  ConversationRuntime,
  ListenerRuntime,
} from "@/websocket/listener/types";

/** Env-var config for the runtime watchdog. */
interface RuntimeWatchdogConfig {
  enabled: boolean;
  /** Force-clear runtimes stuck in isProcessing for longer than this. */
  timeoutMs: number;
  /** How often to scan conversationRuntimes. */
  scanIntervalMs: number;
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_SCAN_INTERVAL_MS = 60_000; // 1 minute

function readBoolEnv(name: string): boolean {
  const raw = process.env[name]?.toLowerCase().trim();
  return raw === "1" || raw === "true" || raw === "yes";
}

function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readConfig(): RuntimeWatchdogConfig {
  return {
    enabled: readBoolEnv("LETTA_RUNTIME_WATCHDOG_ENABLED"),
    timeoutMs: readIntEnv(
      "LETTA_RUNTIME_WATCHDOG_TIMEOUT_MS",
      DEFAULT_TIMEOUT_MS,
    ),
    scanIntervalMs: readIntEnv(
      "LETTA_RUNTIME_WATCHDOG_SCAN_INTERVAL_MS",
      DEFAULT_SCAN_INTERVAL_MS,
    ),
  };
}

function forceClearStuckRuntime(
  runtime: ConversationRuntime,
  elapsedMs: number,
): void {
  const minutes = Math.round(elapsedMs / 60_000);

  if (runtime.activeAbortController) {
    try {
      runtime.activeAbortController.abort();
    } catch {
      // best-effort
    }
  }

  runtime.isProcessing = false;
  runtime.cancelRequested = false;
  runtime.activeAbortController = null;
  runtime.activeRunId = null;
  runtime.activeRunStartedAt = null;
  runtime.activeExecutingToolCallIds = [];

  console.warn(
    `[RuntimeWatchdog] force-cleared stuck runtime for conversation ${runtime.conversationId}, was stuck for ${minutes}m`,
  );
}

/**
 * Start a periodic safety-net watchdog for stuck conversation runtimes.
 * Returns a no-op cleanup function when the watchdog is disabled.
 *
 * The interval is `.unref()`'d so it does not keep the process alive on
 * its own. Call the returned function on listener shutdown for an
 * immediate clear; otherwise it is harmless if the process exits first.
 */
export function startRuntimeWatchdog(listener: ListenerRuntime): () => void {
  const config = readConfig();
  if (!config.enabled) {
    return () => {
      // disabled: nothing to clean up
    };
  }

  const scan = (): void => {
    const now = Date.now();
    for (const runtime of listener.conversationRuntimes.values()) {
      if (!runtime.isProcessing) continue;
      if (!runtime.activeRunStartedAt) continue;

      const startedAtMs = new Date(runtime.activeRunStartedAt).getTime();
      if (Number.isNaN(startedAtMs)) continue;

      if (now - startedAtMs > config.timeoutMs) {
        forceClearStuckRuntime(runtime, now - startedAtMs);
      }
    }
  };

  const interval = setInterval(() => {
    try {
      scan();
    } catch {
      // Watchdog must never crash the listener.
    }
  }, config.scanIntervalMs);
  interval.unref();

  return () => {
    clearInterval(interval);
  };
}
